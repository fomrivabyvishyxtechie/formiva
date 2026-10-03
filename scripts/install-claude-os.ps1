$ErrorActionPreference = "Stop"

$Project = (Get-Location).Path
Write-Host "Installing Claude Full-Stack Engineering OS into $Project"

New-Item -ItemType Directory -Force -Path "$Project\.claude\skills" | Out-Null
New-Item -ItemType Directory -Force -Path "$Project\.claude\memory" | Out-Null
New-Item -ItemType Directory -Force -Path "$Project\.claude\commands" | Out-Null

Write-Host ""
Write-Host "Base files are already in the package."
Write-Host "Next, install third-party skills using the commands in INSTALL-SKILLS.md."
Write-Host ""
Write-Host "Recommended: install globally only for skills you want across every project."
Write-Host "Use project-local skills when you want the skill versioned with the repository."
