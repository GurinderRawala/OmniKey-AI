import { execFile } from 'child_process';

// Run against an EMPTY, unpublished file. Never write session context until
// Windows has applied and verified an explicit owner-only DACL. Node's mode
// 0600 alone does not restrict Windows readers.
const OWNER_ONLY_DACL = `
$ErrorActionPreference = 'Stop'
$file = $env:OMNIKEY_CHECKPOINT_FILE
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $file -AclObject $acl
$actual = Get-Acl -LiteralPath $file
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1) { throw 'Checkpoint DACL verification failed' }
if ($rules[0].IsInherited -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Checkpoint DACL verification failed' }
`;

export async function protectEmptyCheckpoint(
  file: string,
  platform = process.platform,
): Promise<void> {
  if (platform !== 'win32') return;
  await new Promise<void>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', OWNER_ONLY_DACL],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 16_384,
        env: { ...process.env, OMNIKEY_CHECKPOINT_FILE: file },
      },
      (error) => {
        if (error)
          reject(new Error('Could not enforce and verify private Windows checkpoint permissions'));
        else resolve();
      },
    );
  });
}
