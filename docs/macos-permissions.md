# Privacy Shield permissions on macOS

Open Kudu normally. When you apply or revert a setting that requires administrator privileges, Kudu asks macOS to display a password dialog. Approve it with an administrator account's credentials. Cancelling the dialog leaves the requested privileged operation unapproved; you can try the setting again.

The **Run as administrator** banner is not shown on macOS. Authorization happens for individual operations, so you do not need to launch the whole application as root or use `sudo`.

Administrator authorization does not guarantee that every setting can be changed. macOS privacy restrictions and organization management profiles can also restrict operations. Check the error shown beside the affected setting. Do not disable system protections to work around a failure.

If an error specifically requests Full Disk Access, review **System Settings → Privacy & Security → Full Disk Access** for Kudu, then quit and reopen Kudu before retrying. Granting this permission is separate from approving an administrator password prompt and is not a universal fix for Privacy Shield failures.

If a setting still fails, include your Kudu version, macOS version, setting name, exact error, and whether a password dialog appeared when reporting the issue. For a managed Mac, contact your administrator if a profile controls the setting.
