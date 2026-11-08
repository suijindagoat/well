@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$url=Read-Host 'Render website URL'; $cfg=@{serverUrl=$url.TrimEnd('/');usbPath='';destinationFolder='Incoming Music';retryMs=1000;parallelTransfers=4}; $cfg | ConvertTo-Json | Set-Content -Encoding UTF8 '.receiver-config.json'"
echo Receiver saved. Insert the USB and run start-usb-receiver.cmd.
pause
