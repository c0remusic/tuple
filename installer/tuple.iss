; Tuple – Max for Live Installer (Windows)
; Build from repo root: python build_installer.py
; #define AppVersion is patched by build_zip.py sync_version() — do not edit by hand.

#define AppName "Tuple"
#define AppVersion "1.4.0"

[Setup]
AppId={{B2A4C8D0-3E5F-4A2B-C6D8-1F3E5A7C9B2D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=c0remusic
AppPublisherURL=https://tuple.live/
DefaultDirName={userdocs}\Ableton\User Library\Presets\Max MIDI Effect\Tuple
DefaultGroupName={#AppName}
OutputBaseFilename=Tuple-Installer
OutputDir=..\site
Compression=lzma2
SolidCompression=yes
DisableProgramGroupPage=yes
DisableReadyMemo=yes
PrivilegesRequired=lowest
WizardStyle=modern
WizardImageFile=wizard_panel.png

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel1=Welcome to the Tuple Installer
WelcomeLabel2=This will copy Tuple into your Ableton Max MIDI Effect folder.%n%nClose Ableton before continuing, then click Install.
SelectDirLabel3=If your Ableton User Library is in a different location, click Browse to find it.
SelectDirBrowseLabel=Tuple will be installed into the folder below.
FinishedHeadingLabel=Tuple is installed
FinishedLabel=Restart Ableton to see the device in the Max MIDI Effect tab.%n%nTo update Tuple later, simply run this installer again — it replaces the previous version.

[Files]
Source: "..\device\tuple.amxd";                DestDir: "{app}";         Flags: ignoreversion
Source: "..\device\tuple_chord_engine.js";      DestDir: "{app}";         Flags: ignoreversion
Source: "..\device\tuple_init_menus.js";        DestDir: "{app}";         Flags: ignoreversion
Source: "..\device\tuple_live_key_observer.js"; DestDir: "{app}";         Flags: ignoreversion
Source: "..\device\tuple_midi_map.js";          DestDir: "{app}";         Flags: ignoreversion
Source: "..\device\tuple_push2_spike.js";       DestDir: "{app}";         Flags: ignoreversion
Source: "..\device\tuple_dl.js";               DestDir: "{app}";         Flags: ignoreversion
Source: "..\device\ui\tuple_ui.html";           DestDir: "{app}\ui";      Flags: ignoreversion
Source: "..\device\ui\fonts\*";                 DestDir: "{app}\ui\fonts"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\manual\Tuple-Manual.pdf";           DestDir: "{app}";         Flags: ignoreversion skipifsourcedoesntexist
