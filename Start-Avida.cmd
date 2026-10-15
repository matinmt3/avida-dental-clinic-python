@echo off
cd /d "%~dp0"
echo Avida Dental Clinic: http://127.0.0.1:8080
python -X utf8 server.py 8080
if errorlevel 1 pause