@echo off
setlocal
set AGENT_IN_BOX_QEMU_INTEGRATION=1
set AGENT_IN_BOX_QEMU_DIR=%LOCALAPPDATA%\AgentInBox\tools\msys64\ucrt64\bin
set AGENT_IN_BOX_BASE_IMAGE=%LOCALAPPDATA%\AgentInBox\images\noble-server-cloudimg-amd64.img
set AGENT_IN_BOX_VM_STORAGE=%LOCALAPPDATA%\AgentInBox\vms-go
set AGENT_IN_BOX_SEED_IMAGE=%LOCALAPPDATA%\AgentInBox\vms\phase0-linux\seed.iso
"%LOCALAPPDATA%\AgentInBox\tools\vmprovider-integration.test.exe" -test.v -test.run TestQemuProviderIntegration -test.timeout 6m > "%LOCALAPPDATA%\AgentInBox\vms-go-test-output.txt" 2>&1
exit /b %ERRORLEVEL%
