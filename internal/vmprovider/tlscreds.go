package vmprovider

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"agent-in-box/internal/securefile"
)

// File names QEMU's tls-creds-x509 expects for a server endpoint. The client
// certificate files are private to the control plane proxy.
const (
	tlsCACertFile     = "ca-cert.pem"
	tlsServerCertFile = "server-cert.pem"
	tlsServerKeyFile  = "server-key.pem"
	tlsClientCertFile = "client-cert.pem"
	tlsClientKeyFile  = "client-key.pem"
)

// vmCredentials are the per-VM TLS identities used by QMP (on Windows) and by
// the VNC endpoint on every platform. Each VM gets its own CA so a certificate
// from one VM never authenticates another.
type vmCredentials struct {
	Dir            string
	CACertPath     string
	ServerCertPath string
	ServerKeyPath  string
	ClientCertPath string
	ClientKeyPath  string
	// Fingerprint is the lowercase hex SHA-256 of the server certificate DER.
	// The control plane pins it instead of relying on a shared public PKI.
	Fingerprint string
}

func credentialsDir(vmDir string) string {
	return filepath.Join(vmDir, "tls")
}

// loadVMCredentials returns the existing credentials or generates them. Key
// material is written with 0600 and the directory with 0700.
func loadVMCredentials(vmDir string) (vmCredentials, error) {
	dir := credentialsDir(vmDir)
	credentials := vmCredentials{
		Dir:            dir,
		CACertPath:     filepath.Join(dir, tlsCACertFile),
		ServerCertPath: filepath.Join(dir, tlsServerCertFile),
		ServerKeyPath:  filepath.Join(dir, tlsServerKeyFile),
		ClientCertPath: filepath.Join(dir, tlsClientCertFile),
		ClientKeyPath:  filepath.Join(dir, tlsClientKeyFile),
	}
	complete, err := credentialsPresent(credentials)
	if err != nil {
		return vmCredentials{}, err
	}
	if !complete {
		if err := generateVMCredentials(credentials); err != nil {
			return vmCredentials{}, err
		}
	}
	fingerprint, err := certificateFingerprint(credentials.ServerCertPath)
	if err != nil {
		return vmCredentials{}, err
	}
	credentials.Fingerprint = fingerprint
	return credentials, nil
}

func credentialsPresent(credentials vmCredentials) (bool, error) {
	paths := []string{
		credentials.CACertPath, credentials.ServerCertPath, credentials.ServerKeyPath,
		credentials.ClientCertPath, credentials.ClientKeyPath,
	}
	present := 0
	for _, path := range paths {
		if _, err := os.Stat(path); err == nil {
			present++
		} else if !errors.Is(err, os.ErrNotExist) {
			return false, fmt.Errorf("inspect vm credentials %s: %w", path, err)
		}
	}
	if present == 0 {
		return false, nil
	}
	if present != len(paths) {
		return false, fmt.Errorf("vm credentials in %s are incomplete", credentials.Dir)
	}
	return true, nil
}

func generateVMCredentials(credentials vmCredentials) error {
	if err := os.MkdirAll(credentials.Dir, 0o700); err != nil {
		return fmt.Errorf("create vm credentials directory: %w", err)
	}
	now := time.Now()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	caTemplate := &x509.Certificate{
		SerialNumber:          serialNumber(),
		Subject:               pkix.Name{CommonName: "agent-in-box vm CA", Organization: []string{"agent-in-box"}},
		NotBefore:             now.Add(-time.Minute),
		NotAfter:              now.AddDate(5, 0, 0),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return fmt.Errorf("create vm CA certificate: %w", err)
	}
	if err := writePEM(credentials.CACertPath, "CERTIFICATE", caDER); err != nil {
		return err
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		return err
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: serialNumber(),
		Subject:      pkix.Name{CommonName: "agent-in-box-qemu", Organization: []string{"agent-in-box"}},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.AddDate(3, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"agent-in-box-qemu"},
		IPAddresses:  []net.IP{net.ParseIP(hostLoopbackAlias)},
	}
	if err := writeLeafCertificate(credentials.ServerCertPath, credentials.ServerKeyPath, serverTemplate, caCert, caKey); err != nil {
		return err
	}
	clientTemplate := &x509.Certificate{
		SerialNumber: serialNumber(),
		Subject:      pkix.Name{CommonName: "agent-in-box-console", Organization: []string{"agent-in-box"}},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.AddDate(3, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	return writeLeafCertificate(credentials.ClientCertPath, credentials.ClientKeyPath, clientTemplate, caCert, caKey)
}

func writeLeafCertificate(
	certPath string,
	keyPath string,
	template *x509.Certificate,
	ca *x509.Certificate,
	caKey *ecdsa.PrivateKey,
) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca, &key.PublicKey, caKey)
	if err != nil {
		return fmt.Errorf("create vm leaf certificate: %w", err)
	}
	if err := writePEM(certPath, "CERTIFICATE", der); err != nil {
		return err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	return writePEM(keyPath, "EC PRIVATE KEY", keyDER)
}

func writePEM(path string, blockType string, der []byte) error {
	var buffer strings.Builder
	if err := pem.Encode(&buffer, &pem.Block{Type: blockType, Bytes: der}); err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	// Reuse the token-file installer so the private key gets an owner-only mode
	// on Unix and a protected DACL on Windows; os.FileMode alone does not
	// restrict ACLs.
	if err := securefile.InstallTokenAtomically(path, buffer.String()); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}

func serialNumber() *big.Int {
	limit := new(big.Int).Lsh(big.NewInt(1), 128)
	value, err := rand.Int(rand.Reader, limit)
	if err != nil {
		return big.NewInt(time.Now().UnixNano())
	}
	return value
}

func certificateFingerprint(path string) (string, error) {
	data, err := securefile.ReadToken(path)
	if err != nil {
		return "", fmt.Errorf("read server certificate: %w", err)
	}
	block, _ := pem.Decode([]byte(data))
	if block == nil {
		return "", fmt.Errorf("server certificate %s is not PEM", path)
	}
	sum := sha256.Sum256(block.Bytes)
	return hex.EncodeToString(sum[:]), nil
}

// pinnedClientConfig returns a TLS config that trusts exactly the VM's CA and
// presents the console client certificate, with the server certificate pinned
// to the expected fingerprint.
func pinnedClientConfig(credentials vmCredentials) (*tls.Config, error) {
	caData, err := securefile.ReadToken(credentials.CACertPath)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(caData)) {
		return nil, errors.New("vm CA certificate could not be parsed")
	}
	certPEM, err := securefile.ReadToken(credentials.ClientCertPath)
	if err != nil {
		return nil, err
	}
	keyPEM, err := securefile.ReadToken(credentials.ClientKeyPath)
	if err != nil {
		return nil, err
	}
	clientCert, err := tls.X509KeyPair([]byte(certPEM), []byte(keyPEM))
	if err != nil {
		return nil, fmt.Errorf("load console client certificate: %w", err)
	}
	expected := credentials.Fingerprint
	config := &tls.Config{
		MinVersion:   tls.VersionTLS12,
		RootCAs:      pool,
		Certificates: []tls.Certificate{clientCert},
		ServerName:   "agent-in-box-qemu",
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("qemu presented no certificate")
			}
			sum := sha256.Sum256(state.PeerCertificates[0].Raw)
			if hex.EncodeToString(sum[:]) != expected {
				return errors.New("qemu certificate fingerprint mismatch")
			}
			return nil
		},
	}
	return config, nil
}
