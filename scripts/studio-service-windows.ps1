[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('Install','Status','Start','Stop','Uninstall','RunJob','RunGuardian')][string]$Action,
  [string]$TaskName = 'Studio-Local-Guardian',
  [string]$RuntimeDirectory,
  [string]$NodePath,
  [string]$ManagerConfig,
  [string]$OpsDirectory,
  [ValidateSet('local','test','staging','production')][string]$OpsEnvironment = 'local',
  [string]$ManagerScript,
  [string]$GuardianScript,
  [string]$ManagerArgumentsBase64,
  [int]$ParentPid,
  [int]$GuardianPort,
  [int]$ManagerPort = 3009,
  [int]$GuardianRestartDelayMs = 5000,
  [int]$GuardianRestartLimit = 5,
  [int]$GuardianRestartWindowSeconds = 120,
  [int]$GuardianHealthGraceMs = 30000,
  [int]$GuardianHealthIntervalMs = 5000,
  [int]$GuardianHealthTimeoutMs = 1500
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $RuntimeDirectory) { $RuntimeDirectory = Join-Path $projectRoot '.qa/local-service' }
$RuntimeDirectory = [IO.Path]::GetFullPath($RuntimeDirectory)
if ($Action -in @('Install','RunJob','RunGuardian')) {
  if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
  $NodePath = [IO.Path]::GetFullPath($NodePath)
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node executable is missing' }
}
if ($TaskName -notmatch '^Studio-[A-Za-z0-9_-]+$') { throw 'Use an explicit Studio- task name' }

function Quote-Argument([string]$Value) {
  if ($Value.Length -eq 0) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}
function Read-ManagerArguments([string]$Encoded) {
  try {
    if (-not $Encoded -or $Encoded.Length -gt 21848) { throw 'Invalid' }
    $decodedBytes = [Convert]::FromBase64String($Encoded)
    if ($decodedBytes.Length -gt 16384) { throw 'Invalid' }
    $json = ([Text.UTF8Encoding]::new($false,$true)).GetString($decodedBytes).Trim()
    if (-not $json.StartsWith('[') -or -not $json.EndsWith(']')) { throw 'Invalid' }
    # PS5 ConvertFrom-Json emits the entire JSON array as one pipeline object.
    # Assign first, then explicitly enumerate; @(... | ConvertFrom-Json) nests it.
    $decoded = ConvertFrom-Json -InputObject $json -ErrorAction Stop
    $arguments = [Collections.Generic.List[string]]::new()
    foreach ($argument in $decoded) {
      if ($argument -isnot [string] -or $argument.Length -gt 4096 -or $argument.Contains([char]0)) { throw 'Invalid' }
      $arguments.Add($argument)
      if ($arguments.Count -gt 128) { throw 'Invalid' }
    }
    if ($arguments.Count -eq 0) { throw 'Invalid' }
    return $arguments.ToArray()
  } catch { throw [IO.InvalidDataException]::new('MANAGER_ARGUMENTS_INVALID') }
}
function Write-PrivateJson([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path + '.tmp', ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath ($Path + '.tmp') -Destination $Path -Force
}

if ($Action -in @('RunJob','RunGuardian')) {
  if ($Action -eq 'RunJob') {
  if ($ParentPid -le 0 -or $GuardianPort -le 0 -or -not $env:STUDIO_GUARDIAN_OWNER_TOKEN) { throw 'Owned guardian identity is required' }
  if (-not $ManagerScript) { $ManagerScript = Join-Path $projectRoot 'scripts/studio-local.mjs' }
  $ManagerScript = [IO.Path]::GetFullPath($ManagerScript)
  if (-not (Test-Path -LiteralPath $ManagerScript -PathType Leaf)) { throw 'Manager script is missing' }
  $managerArgs = @('--run','--directory',$RuntimeDirectory,'--manager-port',[string]$ManagerPort)
  if ($ManagerArgumentsBase64) {
    try { $managerArgs = @(Read-ManagerArguments $ManagerArgumentsBase64) }
    catch { [Console]::Error.WriteLine('MANAGER_ARGUMENTS_INVALID'); exit 78 }
  } elseif ($ManagerConfig) { $managerArgs += @('--manager-config',[IO.Path]::GetFullPath($ManagerConfig)) }
  # Authenticate the live guardian before opening its process handle. Never trust a saved PID alone.
  $tcp = [Net.Sockets.TcpClient]::new()
  try {
    $tcp.Connect('127.0.0.1',$GuardianPort)
    $stream = $tcp.GetStream(); $stream.ReadTimeout = 1500; $stream.WriteTimeout = 1500
    $request = @{ protocol=2; nonce=$env:STUDIO_GUARDIAN_OWNER_TOKEN; command='ping' } | ConvertTo-Json -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($request + "`n"); $stream.Write($bytes,0,$bytes.Length)
    $reader = [IO.StreamReader]::new($stream)
    $response = $reader.ReadToEnd() | ConvertFrom-Json
    if (-not $response.ok -or $response.kind -ne 'studio-guardian' -or [int]$response.pid -ne $ParentPid) { throw 'Guardian nonce/identity mismatch' }
  } finally { $tcp.Dispose() }
  } else {
    if (Test-Path -LiteralPath (Join-Path $RuntimeDirectory 'guardian-recovery-blocked.json')) { exit 78 }
    if (-not $GuardianScript) { $GuardianScript = Join-Path $projectRoot 'scripts/studio-guardian.mjs' }
    $ManagerScript = [IO.Path]::GetFullPath($GuardianScript)
    if (-not (Test-Path -LiteralPath $ManagerScript -PathType Leaf)) { throw 'Guardian entry script is missing' }
    if ($GuardianRestartDelayMs -lt 50 -or $GuardianRestartDelayMs -gt 30000 -or $GuardianRestartLimit -lt 0 -or $GuardianRestartLimit -gt 20 -or $GuardianRestartWindowSeconds -lt 1) { throw 'Invalid bounded guardian restart policy' }
    if ($GuardianHealthGraceMs -lt 0 -or $GuardianHealthIntervalMs -lt 50 -or $GuardianHealthTimeoutMs -lt 50 -or $GuardianHealthTimeoutMs -gt 5000) { throw 'Invalid guardian health policy' }
    $managerArgs = @('--run','--directory',$RuntimeDirectory,'--manager-port',[string]$ManagerPort)
    if ($PSBoundParameters.ContainsKey('GuardianPort')) { $managerArgs += @('--guardian-port',[string]$GuardianPort) }
    if ($ManagerConfig) { $managerArgs += @('--manager-config',[IO.Path]::GetFullPath($ManagerConfig)) }
    if ($OpsDirectory) { $managerArgs += @('--ops-directory',[IO.Path]::GetFullPath($OpsDirectory),'--ops-environment',$OpsEnvironment) }
    $ParentPid = $PID
  }
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.Runtime.InteropServices;
public static class StudioOwnedJob {
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public int cb; public IntPtr reserved, desktop, title; public int x,y,xSize,ySize,xCountChars,yCountChars,fillAttribute,flags;
    public short showWindow,reserved2; public IntPtr reservedBytes,input,output,error;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long processTime,jobTime; public uint flags; public UIntPtr minWorking,maxWorking; public uint activeLimit;
    public UIntPtr affinity; public uint priority,scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory,jobMemory,peakProcessMemory,peakJobMemory;
  }
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a,string n);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr p,int l);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
  [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr p,out long created,out long exited,out long kernel,out long user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static Exception WinError(string stage) { return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),stage); }
  public static int Run(string exe,string command,string cwd,string output,string error,int parentPid) {
    return RunGuarded(exe,command,cwd,output,error,parentPid,null,0,5000);
  }
  public static int RunGuarded(string exe,string command,string cwd,string output,string error,int parentPid,Func<int,int> health,int graceMs,int intervalMs) {
    IntPtr parent=OpenProcess(0x100000|0x1000,false,parentPid),job=IntPtr.Zero,info=IntPtr.Zero;
    PROCESS_INFORMATION pi=new PROCESS_INFORMATION();
    if(parent==IntPtr.Zero)throw WinError("guardian process handle");
    using(FileStream stdout=new FileStream(output,FileMode.Append,FileAccess.Write,FileShare.ReadWrite))
    using(FileStream stderr=new FileStream(error,FileMode.Append,FileAccess.Write,FileShare.ReadWrite)) {
      try {
        long created,exited,kernel,user;
        if(!GetProcessTimes(parent,out created,out exited,out kernel,out user))throw WinError("guardian start identity");
        if(WaitForSingleObject(parent,0)==0)throw new InvalidOperationException("guardian already exited");
        job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw WinError("job create");
        EXTENDED_LIMIT limit=new EXTENDED_LIMIT();limit.basic.flags=0x2000;
        info=Marshal.AllocHGlobal(Marshal.SizeOf(limit));Marshal.StructureToPtr(limit,info,false);
        if(!SetInformationJobObject(job,9,info,Marshal.SizeOf(limit)))throw WinError("job limits");
        STARTUPINFO si=new STARTUPINFO();si.cb=Marshal.SizeOf(si);si.flags=0x100;
        si.output=stdout.SafeFileHandle.DangerousGetHandle();si.error=stderr.SafeFileHandle.DangerousGetHandle();
        if(!SetHandleInformation(si.output,1,1)||!SetHandleInformation(si.error,1,1))throw WinError("owned log handles");
        if(!CreateProcess(exe,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,true,0x4|0x08000000,IntPtr.Zero,cwd,ref si,out pi))throw WinError("suspended manager create");
        if(!AssignProcessToJobObject(job,pi.process)) { TerminateProcess(pi.process,78);throw WinError("job assignment"); }
        if(WaitForSingleObject(parent,0)==0)throw new InvalidOperationException("guardian exited before manager release");
        if(ResumeThread(pi.thread)==0xffffffff)throw WinError("manager release");
        Console.WriteLine("{\"type\":\"job-owned\",\"managerPid\":"+pi.pid+",\"guardianStartIdentity\":\""+created+"\"}");
        DateTime nextHealth=DateTime.UtcNow.AddMilliseconds(graceMs);int failed=0;
        while(WaitForSingleObject(pi.process,100)==258) {
          if(WaitForSingleObject(parent,0)==0)return 0;
          if(health!=null&&DateTime.UtcNow>=nextHealth) {
            int healthState=2;try { healthState=health(pi.pid); } catch {}
            failed=healthState==0?failed+1:0;nextHealth=DateTime.UtcNow.AddMilliseconds(intervalMs);
            if(failed>=3) { Console.WriteLine("{\"type\":\"guardian-health-threshold\",\"category\":\"responsiveness\",\"adviceCode\":\"CHECK_SERVICE\"}");return 79; }
          }
        }
        uint code;if(!GetExitCodeProcess(pi.process,out code))throw WinError("manager exit status");
        return unchecked((int)code);
      } finally {
        // The job owns handles, not saved PID numbers. Closing kills only this contained family.
        if(job!=IntPtr.Zero)CloseHandle(job);
        if(pi.thread!=IntPtr.Zero)CloseHandle(pi.thread);if(pi.process!=IntPtr.Zero)CloseHandle(pi.process);
        if(info!=IntPtr.Zero)Marshal.FreeHGlobal(info);CloseHandle(parent);
      }
    }
  }
}
'@
  [IO.Directory]::CreateDirectory($RuntimeDirectory) | Out-Null
  $commandLine = (@($NodePath,$ManagerScript) + $managerArgs | ForEach-Object { Quote-Argument ([string]$_) }) -join ' '
  if ($commandLine.Length -gt 32766) { [Console]::Error.WriteLine('MANAGER_ARGUMENTS_INVALID'); exit 78 }
  if ($Action -eq 'RunJob') {
    $exitCode = [StudioOwnedJob]::Run($NodePath,$commandLine,$projectRoot,(Join-Path $RuntimeDirectory 'manager.stdout.log'),(Join-Path $RuntimeDirectory 'manager.stderr.log'),$ParentPid)
    exit $exitCode
  }
  $failures = [Collections.Generic.List[DateTime]]::new()
  $health = [Func[int,int]] {
    param([int]$ExpectedPid)
    $client = $null; $verified = $false
    try {
      $owner = Get-Content -LiteralPath (Join-Path $RuntimeDirectory 'guardian.json') -Raw | ConvertFrom-Json
      if ($owner.protocol -ne 2 -or $owner.kind -ne 'studio-guardian' -or $owner.root -ne $projectRoot -or [int]$owner.pid -ne $ExpectedPid) { return 2 }
      $verified = $true
      $client = [Net.Sockets.TcpClient]::new()
      $connecting = $client.BeginConnect('127.0.0.1',[int]$owner.port,$null,$null)
      if (-not $connecting.AsyncWaitHandle.WaitOne($GuardianHealthTimeoutMs)) { return 0 }
      $client.EndConnect($connecting)
      $stream = $client.GetStream(); $stream.ReadTimeout=$GuardianHealthTimeoutMs; $stream.WriteTimeout=$GuardianHealthTimeoutMs
      $json = @{ protocol=2;nonce=$owner.nonce;command='ping' } | ConvertTo-Json -Compress
      $bytes = [Text.Encoding]::UTF8.GetBytes($json + "`n");$stream.Write($bytes,0,$bytes.Length)
      $buffer = [byte[]]::new(4096);$length=$stream.Read($buffer,0,$buffer.Length)
      try { $reply = [Text.Encoding]::UTF8.GetString($buffer,0,$length) | ConvertFrom-Json } catch { return 2 }
      if ($reply.ok -and $reply.kind -eq 'studio-guardian' -and [int]$reply.pid -eq $ExpectedPid) { return 1 }
      return 2
    } catch { if($verified -and $client){return 0}else{return 2} } finally { if($client){$client.Dispose()} }
  }
  while ($true) {
    $exitCode = [StudioOwnedJob]::RunGuarded($NodePath,$commandLine,$projectRoot,(Join-Path $RuntimeDirectory 'guardian.stdout.log'),(Join-Path $RuntimeDirectory 'guardian.stderr.log'),$ParentPid,$health,$GuardianHealthGraceMs,$GuardianHealthIntervalMs)
    if ($exitCode -eq 0) { exit 0 }
    if ($exitCode -in @(73,74,78)) {
      Write-PrivateJson (Join-Path $RuntimeDirectory 'guardian-recovery-blocked.json') @{ category='startup'; adviceCode='CHECK_SERVICE'; blockedAt=[DateTime]::UtcNow.ToString('o') }
      exit $exitCode
    }
    $now = [DateTime]::UtcNow
    for ($index=$failures.Count-1; $index -ge 0; $index--) { if (($now-$failures[$index]).TotalSeconds -ge $GuardianRestartWindowSeconds) { $failures.RemoveAt($index) } }
    $failures.Add($now)
    if ($failures.Count -gt $GuardianRestartLimit) {
      Write-PrivateJson (Join-Path $RuntimeDirectory 'guardian-recovery-blocked.json') @{ category='restart-budget'; adviceCode='CHECK_RESTART_BUDGET'; blockedAt=[DateTime]::UtcNow.ToString('o') }
      '{"type":"guardian-restart-budget-exhausted","category":"restart-budget","adviceCode":"CHECK_RESTART_BUDGET"}'; exit 78
    }
    $waitMs = [int][Math]::Min(30000,$GuardianRestartDelayMs * [Math]::Pow(2,$failures.Count-1))
    @{ type='guardian-restart-scheduled'; category='responsiveness'; adviceCode='CHECK_SERVICE'; waitMs=$waitMs } | ConvertTo-Json -Compress
    Start-Sleep -Milliseconds $waitMs
  }
}

$ownerFile = Join-Path $RuntimeDirectory 'windows-task-owner.json'
function Get-OwnedTask {
  if (-not (Test-Path -LiteralPath $ownerFile -PathType Leaf)) { throw 'No owned task registration exists in this runtime directory' }
  $owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
  if ($owner.root -ne $projectRoot -or $owner.taskName -ne $TaskName) { throw 'Task registration identity mismatch' }
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ($task.Description -ne $owner.description -or $task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ne $owner.actionExecutable -or $task.Actions[0].Arguments -ne $owner.actionArguments) { throw 'Existing task is not owned by this registration' }
  return $task
}
if ($Action -eq 'Install') {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'Task name already exists; no existing task is replaced' }
  if (Test-Path -LiteralPath $ownerFile) { throw 'Runtime directory already contains a task registration; no ownership overwritten' }
  [IO.Directory]::CreateDirectory($RuntimeDirectory) | Out-Null
  $account = [Security.Principal.WindowsIdentity]::GetCurrent()
  $security = [Security.AccessControl.DirectorySecurity]::new(); $security.SetAccessRuleProtection($true,$false); $security.SetOwner($account.User)
  $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  foreach ($sid in @($account.User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inheritance,'None','Allow'))
  }
  Set-Acl -LiteralPath $RuntimeDirectory -AclObject $security
  $nonce = [guid]::NewGuid().ToString(); $description = 'Studio guardian registration ' + $nonce + ' root=' + $projectRoot
  if (-not $GuardianScript) { $GuardianScript = Join-Path $projectRoot 'scripts/studio-guardian.mjs' }
  $GuardianScript = [IO.Path]::GetFullPath($GuardianScript)
  if (-not (Test-Path -LiteralPath $GuardianScript -PathType Leaf)) { throw 'Guardian entry script is missing' }
  $taskExecutable = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'studio-service-windows.ps1'),'-Action','RunGuardian','-NodePath',$NodePath,'-GuardianScript',$GuardianScript,'-RuntimeDirectory',$RuntimeDirectory,'-ManagerPort',[string]$ManagerPort,'-GuardianRestartDelayMs',[string]$GuardianRestartDelayMs,'-GuardianRestartLimit',[string]$GuardianRestartLimit,'-GuardianRestartWindowSeconds',[string]$GuardianRestartWindowSeconds,'-GuardianHealthGraceMs',[string]$GuardianHealthGraceMs,'-GuardianHealthIntervalMs',[string]$GuardianHealthIntervalMs,'-GuardianHealthTimeoutMs',[string]$GuardianHealthTimeoutMs)
  if ($PSBoundParameters.ContainsKey('GuardianPort')) { $args += @('-GuardianPort',[string]$GuardianPort) }
  if ($ManagerConfig) { $args += @('-ManagerConfig',[IO.Path]::GetFullPath($ManagerConfig)) }
  if ($OpsDirectory) { $args += @('-OpsDirectory',[IO.Path]::GetFullPath($OpsDirectory),'-OpsEnvironment',$OpsEnvironment) }
  $taskArguments = ($args | ForEach-Object { Quote-Argument $_ }) -join ' '
  $actionDef = New-ScheduledTaskAction -Execute $taskExecutable -Argument $taskArguments -WorkingDirectory $projectRoot
  $trigger = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 1)))
  $principal = New-ScheduledTaskPrincipal -UserId $account.Name -LogonType S4U -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Write-PrivateJson $ownerFile @{ root=$projectRoot; taskName=$TaskName; description=$description; nonce=$nonce; account=$account.Name; nodePath=$NodePath; actionExecutable=$taskExecutable; actionArguments=$taskArguments; createdAt=[DateTime]::UtcNow.ToString('o') }
  try { Register-ScheduledTask -TaskName $TaskName -Action $actionDef -Trigger $trigger -Principal $principal -Settings $settings -Description $description | Out-Null }
  catch { Remove-Item -LiteralPath $ownerFile; throw }
  @{ installed=$true; taskName=$TaskName; account=$account.Name; logonType='S4U'; startupTriggerRegistered=$true; actualBootTested=$false } | ConvertTo-Json -Compress
  exit 0
}
$task = Get-OwnedTask
if ($Action -in @('Stop','Uninstall')) {
  if (-not $NodePath) { $NodePath = (Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json).nodePath }
  $NodePath = [IO.Path]::GetFullPath($NodePath)
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Registered Node executable is missing; no unrelated executable substituted' }
}
if ($Action -eq 'Start') {
  $blocked = Join-Path $RuntimeDirectory 'guardian-recovery-blocked.json'
  if (Test-Path -LiteralPath $blocked) { Remove-Item -LiteralPath $blocked }
  Enable-ScheduledTask -TaskName $TaskName | Out-Null
  Start-ScheduledTask -TaskName $TaskName
}
if ($Action -in @('Stop','Uninstall')) {
  Disable-ScheduledTask -TaskName $TaskName | Out-Null
  & $NodePath (Join-Path $projectRoot 'scripts/studio-guardian.mjs') '--stop' '--directory' $RuntimeDirectory
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  if ((Get-ScheduledTask -TaskName $TaskName).State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
}
if ($Action -eq 'Uninstall') {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Remove-Item -LiteralPath $ownerFile
  @{ uninstalled=$true; taskName=$TaskName; runtimeLogsPreserved=$true } | ConvertTo-Json -Compress
  exit 0
}
$task = Get-OwnedTask; $info = Get-ScheduledTaskInfo -TaskName $TaskName
@{ taskName=$TaskName; state=[string]$task.State; lastTaskResult=$info.LastTaskResult; lastRunTime=$info.LastRunTime.ToUniversalTime().ToString('o');
  account=$task.Principal.UserId; logonType=[string]$task.Principal.LogonType; startupTriggerRegistered=@($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }).Count -gt 0; actualBootTested=$false } | ConvertTo-Json -Compress
