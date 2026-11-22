//go:build windows

package securefile

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

const (
	fileFlagOpenReparsePoint         = 0x00200000
	fileAttributeDirectory           = 0x00000010
	fileAttributeReparsePoint        = 0x00000400
	seFileObject                     = 1
	daclSecurityInformation          = 0x00000004
	protectedDaclSecurityInformation = 0x80000000
	seDaclProtected                  = 0x1000
	aclSizeInformation               = 2
	accessAllowedAceType             = 0
	fileTypeDisk                     = 1
	readControl                      = 0x00020000
	writeDac                         = 0x00040000
)

var (
	advapi32                                                 = syscall.NewLazyDLL("advapi32.dll")
	kernel32                                                 = syscall.NewLazyDLL("kernel32.dll")
	procGetFileType                                          = kernel32.NewProc("GetFileType")
	procGetSecurityInfo                                      = advapi32.NewProc("GetSecurityInfo")
	procSetSecurityInfo                                      = advapi32.NewProc("SetSecurityInfo")
	procGetSecurityDescriptorControl                         = advapi32.NewProc("GetSecurityDescriptorControl")
	procGetSecurityDescriptorDacl                            = advapi32.NewProc("GetSecurityDescriptorDacl")
	procGetAclInformation                                    = advapi32.NewProc("GetAclInformation")
	procGetAce                                               = advapi32.NewProc("GetAce")
	procConvertStringSecurityDescriptorToSecurityDescriptorW = advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
)

type aclSizeInfo struct {
	aceCount      uint32
	aclBytesInUse uint32
	aclBytesFree  uint32
}

type aceHeader struct {
	aceType  byte
	aceFlags byte
	aceSize  uint16
}

func openTokenFile(path string) (*os.File, error) {
	pathPointer, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(
		pathPointer,
		syscall.GENERIC_READ|readControl,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		fileFlagOpenReparsePoint,
		0,
	)
	if err != nil {
		return nil, fmt.Errorf("open token file %q without following reparse points: %w", path, err)
	}
	file := os.NewFile(uintptr(handle), path)
	if err := validateWindowsTokenHandle(handle, path); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}

func validateWindowsTokenHandle(handle syscall.Handle, path string) error {
	var nativeInfo syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &nativeInfo); err != nil {
		return fmt.Errorf("inspect opened token file %q: %w", path, err)
	}
	if nativeInfo.FileAttributes&(fileAttributeDirectory|fileAttributeReparsePoint) != 0 {
		return fmt.Errorf("token file %q must not be a directory or reparse point", path)
	}
	fileType, _, _ := procGetFileType.Call(uintptr(handle))
	if fileType != fileTypeDisk {
		return fmt.Errorf("token file %q is not a local disk file", path)
	}
	size := int64(nativeInfo.FileSizeHigh)<<32 | int64(nativeInfo.FileSizeLow)
	if size < 1 || size > MaxTokenBytes {
		return fmt.Errorf("token file %q must contain 1..%d bytes", path, MaxTokenBytes)
	}
	return validateWindowsTokenACL(handle, path)
}

func validateWindowsTokenACL(handle syscall.Handle, path string) error {
	var descriptor uintptr
	var acl uintptr
	result, _, callErr := procGetSecurityInfo.Call(
		uintptr(handle), seFileObject, daclSecurityInformation,
		0, 0, uintptr(unsafe.Pointer(&acl)), 0, uintptr(unsafe.Pointer(&descriptor)),
	)
	if result != 0 {
		return fmt.Errorf("read token ACL for %q: %v (status %d)", path, callErr, result)
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))

	var control uint16
	var revision uint32
	if ok, _, callErr := procGetSecurityDescriptorControl.Call(
		descriptor, uintptr(unsafe.Pointer(&control)), uintptr(unsafe.Pointer(&revision)),
	); ok == 0 {
		return fmt.Errorf("read token ACL control for %q: %v", path, callErr)
	}
	if control&seDaclProtected == 0 {
		return fmt.Errorf("token file %q inherits ACL entries; disable inheritance and grant only the service identity", path)
	}

	var present int32
	var defaulted int32
	if ok, _, callErr := procGetSecurityDescriptorDacl.Call(
		descriptor, uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&acl)), uintptr(unsafe.Pointer(&defaulted)),
	); ok == 0 {
		return fmt.Errorf("read token DACL for %q: %v", path, callErr)
	}
	if present == 0 || acl == 0 {
		return fmt.Errorf("token file %q has no explicit DACL", path)
	}
	var size aclSizeInfo
	if ok, _, callErr := procGetAclInformation.Call(
		acl, uintptr(unsafe.Pointer(&size)), unsafe.Sizeof(size), aclSizeInformation,
	); ok == 0 {
		return fmt.Errorf("read token ACE count for %q: %v", path, callErr)
	}
	if size.aceCount == 0 || size.aceCount > 16 {
		return fmt.Errorf("token file %q has an unexpected ACE count %d", path, size.aceCount)
	}

	allowed := map[string]bool{
		"S-1-5-18":     true, // LocalSystem
		"S-1-5-32-544": true, // Built-in Administrators
	}
	current, err := currentUserSID()
	if err != nil {
		return fmt.Errorf("resolve current service identity: %w", err)
	}
	allowed[current] = true
	foundCurrent := false
	for index := uint32(0); index < size.aceCount; index++ {
		var ace unsafe.Pointer
		if ok, _, callErr := procGetAce.Call(acl, uintptr(index), uintptr(unsafe.Pointer(&ace))); ok == 0 {
			return fmt.Errorf("read token ACE %d for %q: %v", index, path, callErr)
		}
		header := (*aceHeader)(ace)
		if header.aceType != accessAllowedAceType {
			return fmt.Errorf("token file %q contains a non-allow ACE (type %d)", path, header.aceType)
		}
		sid := (*syscall.SID)(unsafe.Add(ace, unsafe.Sizeof(aceHeader{})+unsafe.Sizeof(uint32(0))))
		value, err := sid.String()
		if err != nil {
			return fmt.Errorf("decode token ACE SID for %q: %w", path, err)
		}
		if !allowed[value] {
			return fmt.Errorf("token file %q grants access to disallowed SID %s", path, value)
		}
		if value == current {
			foundCurrent = true
		}
	}
	if !foundCurrent {
		return fmt.Errorf("token file %q does not grant access to current service identity %s", path, current)
	}
	return nil
}

func currentUserSID() (string, error) {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String()
}

func protectWindowsTokenHandle(handle syscall.Handle) error {
	current, err := currentUserSID()
	if err != nil {
		return err
	}
	sddl := "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + current + ")"
	sddlPointer, err := syscall.UTF16PtrFromString(sddl)
	if err != nil {
		return err
	}
	var descriptor uintptr
	if ok, _, callErr := procConvertStringSecurityDescriptorToSecurityDescriptorW.Call(
		uintptr(unsafe.Pointer(sddlPointer)), 1, uintptr(unsafe.Pointer(&descriptor)), 0,
	); ok == 0 {
		return fmt.Errorf("build token security descriptor: %v", callErr)
	}
	defer syscall.LocalFree(syscall.Handle(descriptor))
	var acl uintptr
	var present int32
	var defaulted int32
	if ok, _, callErr := procGetSecurityDescriptorDacl.Call(
		descriptor, uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&acl)), uintptr(unsafe.Pointer(&defaulted)),
	); ok == 0 || present == 0 || acl == 0 {
		return fmt.Errorf("read new token DACL: %v", callErr)
	}
	result, _, callErr := procSetSecurityInfo.Call(
		uintptr(handle), seFileObject, daclSecurityInformation|protectedDaclSecurityInformation,
		0, 0, acl, 0, 0,
	)
	if result != 0 {
		return fmt.Errorf("apply protected token ACL: %v (status %d)", callErr, result)
	}
	return nil
}

func replaceTokenFile(temporaryPath, path string) error {
	oldPath, err := syscall.UTF16PtrFromString(temporaryPath)
	if err != nil {
		return err
	}
	newPath, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	const replaceExisting = 0x1
	const writeThrough = 0x8
	result, _, callErr := kernel32.NewProc("MoveFileExW").Call(
		uintptr(unsafe.Pointer(oldPath)),
		uintptr(unsafe.Pointer(newPath)),
		replaceExisting|writeThrough,
	)
	if result == 0 {
		return fmt.Errorf("replace token file: %v", callErr)
	}
	return nil
}

func createTokenTemp(dir, pattern string) (*os.File, error) {
	for attempts := 0; attempts < 100; attempts++ {
		var random [12]byte
		if _, err := rand.Read(random[:]); err != nil {
			return nil, err
		}
		name := ".agent-in-box-token-" + hex.EncodeToString(random[:]) + ".tmp"
		path := filepath.Join(dir, name)
		pathPointer, err := syscall.UTF16PtrFromString(path)
		if err != nil {
			return nil, err
		}
		handle, err := syscall.CreateFile(
			pathPointer,
			syscall.GENERIC_READ|syscall.GENERIC_WRITE|readControl|writeDac,
			syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
			nil,
			syscall.CREATE_NEW,
			fileFlagOpenReparsePoint,
			0,
		)
		if err != nil {
			if os.IsExist(err) {
				continue
			}
			return nil, err
		}
		file := os.NewFile(uintptr(handle), path)
		if err := protectWindowsTokenHandle(handle); err != nil {
			_ = file.Close()
			_ = os.Remove(path)
			return nil, err
		}
		if err := validateWindowsTokenACL(handle, path); err != nil {
			_ = file.Close()
			_ = os.Remove(path)
			return nil, err
		}
		return file, nil
	}
	return nil, fmt.Errorf("could not allocate a unique token temporary file")
}
