# YouTube browser access

Last updated: 2026-11-01

The user cancelled YouTube Like and playlist-saving features. Rupelian now connects the existing signed-in browser account only for video playback access. Social controls, OAuth setup, and the persistent browser rating channel have been removed.

Settings > YouTube has a compact connection card with status, Connect/Refresh access, and Disconnect. During connection it shows the loopback link with Copy/Open and Cancel. Connection options contains one-time Chrome/Edge connector setup and optional cookies.txt import. Failed-video checking and retry appear only when entering Settings from an access error. Playback defaults remain below.

The connector uses only the cookies permission with YouTube and loopback host access. A trusted user click sends YouTube cookies straight from the extension worker to Rust for Windows DPAPI storage. It never creates a profile or navigates/closes personal browser tabs. Public playback needs no connection.

Saved playback access is preserved. Legacy encrypted OAuth and browser bridge files are no longer used and are not deleted. Installed v2 connectors should be reloaded once from chrome://extensions or edge://extensions after updating the application. Exporting the updated connector removes its obsolete ratings.js and action-tab.js assets.

Validation: Node connector boundaries, real desktop session/recovery UI, real Chrome trusted-click transfer using synthetic cookies, and Rust loopback/DPAPI tests. Automated validation never changes a real YouTube account.
