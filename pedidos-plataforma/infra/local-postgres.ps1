<#
.SYNOPSIS
  PostgreSQL local para desarrollo en Windows, sin administrador ni Docker.

.DESCRIPTION
  Usa los binarios de PostgreSQL que trae el paquete `embedded-postgres` (ya instalado con `pnpm install`).
  Se copian a una ruta CORTA (%USERPROFILE%\pasamanos-pg) porque dentro de node_modules la ruta supera los 260
  caracteres de Windows y PostgreSQL no logra abrir sus propios archivos (falla con "extension plpgsql is not available").

  Uso:   .\infra\local-postgres.ps1 setup    # copia binarios e inicializa el cluster (una sola vez)
         .\infra\local-postgres.ps1 start    # arranca el servidor en localhost:5432
         .\infra\local-postgres.ps1 stop
         .\infra\local-postgres.ps1 status

  El cluster inicial usa autenticación "trust" SOLO en localhost. Después de `setup`, ejecutar
  apps/api/scripts/db-setup.mjs para crear las bases, aplicar la migración, fijar contraseñas y exigirlas.
#>
param([Parameter(Position = 0)][ValidateSet('setup', 'start', 'stop', 'status')][string]$Action = 'status')

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Home2 = Join-Path $env:USERPROFILE 'pasamanos-pg'
$Pg = Join-Path $Home2 'pg'
$Bin = Join-Path $Pg 'bin'
$Data = Join-Path $Home2 'data'
$Log = Join-Path $Home2 'postgres.log'
$Port = 5432

function Test-PortOpen { try { (Test-NetConnection localhost -Port $Port -WarningAction SilentlyContinue).TcpTestSucceeded } catch { $false } }

switch ($Action) {
  'setup' {
    if (-not (Test-Path "$Bin\initdb.exe")) {
      $found = Get-ChildItem (Join-Path $Root 'node_modules\.pnpm') -Recurse -Filter initdb.exe -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $found) { throw 'No se encontraron los binarios. Ejecutá `pnpm install` primero.' }
      New-Item -ItemType Directory -Force $Home2 | Out-Null
      Copy-Item (Split-Path $found.FullName -Parent | Split-Path -Parent) $Pg -Recurse -Force
      Write-Host "Binarios copiados a $Pg"
    }
    if (-not (Test-Path "$Data\PG_VERSION")) {
      & "$Bin\initdb.exe" -D $Data -U postgres --auth=trust --locale=C --encoding=UTF8
      if ($LASTEXITCODE -ne 0) { throw 'initdb falló' }
    } else { Write-Host 'El cluster ya estaba inicializado.' }
  }
  'start' {
    if (Test-PortOpen) { Write-Host "Ya hay un servidor escuchando en localhost:$Port"; return }
    # Start-Process (y no `pg_ctl start`) para que el servidor quede desacoplado de esta consola.
    Start-Process -FilePath "$Bin\postgres.exe" -ArgumentList @('-D', "`"$Data`"", '-p', "$Port", '-c', 'listen_addresses=localhost') `
      -WindowStyle Hidden -RedirectStandardError $Log | Out-Null
    for ($i = 0; $i -lt 30 -and -not (Test-PortOpen); $i++) { Start-Sleep -Milliseconds 500 }
    if (Test-PortOpen) { Write-Host "PostgreSQL listo en localhost:$Port" } else { throw "No arrancó. Ver $Log" }
  }
  'stop' { & "$Bin\pg_ctl.exe" -D $Data stop -m fast }
  'status' { & "$Bin\pg_ctl.exe" -D $Data status }
}
