# Windows app access audit

Privacy Shield's **App access** view reads camera, microphone, and location records for the Windows account running Kudu. Refresh rescans; the capability filter, identity search, and last-30-days filter narrow the list. Settings buttons open the corresponding Windows privacy page. Scans stay local and never change permissions or clear records.

## Interpreting the results

- Counts represent recorded identities per capability, including package identities and desktop history. They are not a count of installed applications, permission grants, or access events.
- Device, account, desktop, and entry settings are recorded consent values, not an effective authorization verdict. Policy and other controls can override them. Missing or unrecognized values remain unknown.
- Desktop records may outlive an app installation or omit access. Their names come from recorded paths and do not establish publisher identity or trust.
- Times are Windows FILETIME values parsed without floating-point loss. Invalid, pre-epoch, and future timestamps are not presented as valid usage. A zero end with a valid start is unfinished history; it is not evidence of current recording.
- If Kudu runs with another account's credentials, that account's records are shown. The account label makes this explicit; Windows Settings can use the interactive account instead.

## Collection limits

The collector uses a fixed, read-only PowerShell script and .NET registry handles. It reads `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore` for `webcam`, `microphone`, and `location`, plus each corresponding machine-level consent value. It does not enumerate other users or resolve executable files, network paths, or publisher metadata. Registry entry names never become PowerShell commands.

The registry is an implementation detail, not a public Windows permission API. The audit deliberately reports evidence rather than reconstructing effective access. Each capability is limited to 1,000 collected records; errors and truncation are visible. A scan has a 20-second timeout and a 4 MiB output limit. Scan failures retain the previous snapshot with an explicit stale-results message. Unsupported platforms do not run the Windows collector.

## Microsoft references

- [Windows camera, microphone, and privacy](https://support.microsoft.com/en-us/windows/privacy/windows-camera-microphone-and-privacy)
- [Windows desktop apps and privacy](https://support.microsoft.com/en-gb/windows/privacy/windows-desktop-apps-and-privacy)
- [Launch Windows Settings](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings)

Microsoft documents limitations to desktop app visibility and controls. The three Settings destinations are allowlisted in the main process; callers cannot supply arbitrary URLs.
