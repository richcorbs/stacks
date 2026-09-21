import { CommandPalette } from './CommandPalette';
import { Dialog } from './Dialogs';
import { SettingsDialog } from './SettingsDialog';
import { OneTimeCommandDialog } from './OneTimeCommandDialog';
import { ConfirmDeleteProjectDialog, ConfirmQuitDialog } from './ConfirmDialogs';
import type { OverlayLayoutProps } from './AppLayoutTypes';

export function AppOverlays(props: OverlayLayoutProps) {
  return <>
    <CommandPalette
      open={props.commandPaletteOpen}
      items={props.commandPaletteItems}
      cardItems={props.commandPaletteCardItems}
      onClose={props.closeCommandPalette}
      onRunItem={props.closeCommandPalette}
    />
    {props.settingsOpen && <SettingsDialog settings={props.appSettings} projects={props.projects} initialPage={props.settingsPage} onPageChange={props.setSettingsPage} onSaveSettings={props.saveSettingsSection} onSaveProject={props.saveProjectConfiguration} onDeleteProject={props.deleteSettingsProject} onNotificationsUnavailable={props.notificationsUnavailable} onClose={props.closeSettings} />}
    <OneTimeCommandDialog open={props.oneTimeCommandOpen} cwd={props.oneTimeCommandCwd} onCancel={props.closeOneTimeCommand} onRun={props.runOneTimeCommand} />
    {props.dialog && <Dialog dialog={props.dialog} setDialog={props.setDialog} onCancel={props.closeDialog} onSubmit={props.submitDialog} />}
    {props.confirmDeleteProject && <ConfirmDeleteProjectDialog projectName={props.confirmDeleteProject.name} onCancel={props.cancelDeleteProject} onConfirm={props.deleteProject} />}
    {props.confirmQuitOpen && <ConfirmQuitDialog onCancel={props.cancelQuit} onConfirm={props.quit} />}
    {props.interactionBlocked && <div className="loadingInteractionBlocker" aria-hidden="true" />}
    {props.toast && <div className="toast" style={props.toast.x !== undefined && props.toast.y !== undefined ? { left: props.toast.x, top: props.toast.y } : undefined}>{props.toast.message}</div>}
  </>;
}
