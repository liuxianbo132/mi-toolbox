param(
  [Parameter(Mandatory)][string] $PostgresBin,
  [Parameter(Mandatory)][string] $PgDriver
)

# This harness initializes a disposable, loopback-only cluster with synthetic data.
$ErrorActionPreference = 'Stop'
$PostgresBin = (Resolve-Path -LiteralPath $PostgresBin).Path
$PgDriver = (Resolve-Path -LiteralPath $PgDriver).Path
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('mi-v3-postgres-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $scratch
$data = Join-Path $scratch 'data'
$report = Join-Path $scratch 'postgres.log'
$backup = Join-Path $scratch 'backup'
$restored = Join-Path $scratch 'restored'
$role = 'mi_v3_test'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()

function Invoke-Pg($program) {
  & (Join-Path $PostgresBin "$program.exe") @args
  if ($LASTEXITCODE -ne 0) { throw "$program exited with $LASTEXITCODE" }
}

function Start-FixtureServer($directory, $log) {
  $arguments = "-D `"$directory`" -l `"$log`" -o `"-h 127.0.0.1 -p $port`" -w -t 20 start"
  $process = Start-Process -FilePath (Join-Path $PostgresBin 'pg_ctl.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (!$process.WaitForExit(25000) -or $process.ExitCode -ne 0) { throw "Fixture failed to start. See $log" }
}

function Read-FixtureState($database) {
  $probe = @'
const { Client } = require(process.argv[1]);
const client = new Client({host: '127.0.0.1', port: Number(process.argv[2]), user: 'mi_v3_test', database: process.argv[3]});
async function main() {
  await client.connect();
  try {
    const sql = `SELECT (SELECT count(*) FROM members) AS members, (SELECT count(*) FROM items) AS items,
      (SELECT count(*) FROM batches) AS batches, (SELECT count(*) FROM medication_plans) AS plans,
      (SELECT count(*) FROM medication_doses) AS doses,
      has_table_privilege('authenticated', 'medication_doses', 'UPDATE') AS can_write_doses`;
    console.log(JSON.stringify((await client.query(sql)).rows[0]));
  } finally {
    await client.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
'@
  $value = & node -e $probe $PgDriver $port $database
  if ($LASTEXITCODE -ne 0) { throw 'Fixture state read failed' }
  $value
}

Invoke-Pg initdb -D $data -U $role --auth=trust --encoding=UTF8 --no-locale | Out-Null
$running = $false
$runningData = $data
try {
  Start-FixtureServer $data $report
  $running = $true
  $output = @(& node (Join-Path $PSScriptRoot 'verify-v3-postgres.mjs') --native $PgDriver $port)
  if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL integration tests failed' }
  $output | Write-Output
  $database = ($output | Select-String '^FIXTURE_DATABASE=(mi_v3_[0-9a-f]{32})$').Matches[0].Groups[1].Value
  if (!$database) { throw 'Synthetic fixture database missing' }

  $before = Read-FixtureState $database
  Invoke-Pg pg_ctl -D $data -m fast -w stop | Out-Null
  $running = $false
  Copy-Item -LiteralPath $data -Destination $backup -Recurse
  Copy-Item -LiteralPath $backup -Destination $restored -Recurse
  Start-FixtureServer $restored (Join-Path $scratch 'restored.log')
  $runningData = $restored
  $running = $true
  $after = Read-FixtureState $database
  if ($before -cne $after) { throw "Restore verification mismatch $before / $after" }
  "PASS: backup restored with matching fixture counts and medication table privileges ($after)"
  "Fixture files: $scratch"
} finally {
  if ($running) { Invoke-Pg pg_ctl -D $runningData -m fast -w stop | Out-Null }
}
