@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$url=Read-Host 'Render website URL'; $code=Get-Random -Minimum 100000 -Maximum 1000000; $cfg=@{serverUrl=$url.TrimEnd('/');usbPath='';destinationFolder='Incoming Music';pairingCode=[string]$code;retryMs=1000;parallelTransfers=4}; $cfg | ConvertTo-Json | Set-Content -Encoding UTF8 '.receiver-config.json'; Write-Host ('P2P pairing code: '+$code)"
echo Receiver saved. Insert the USB and run start-usb-receiver.cmd. The receiver will show the pairing code.
pause
