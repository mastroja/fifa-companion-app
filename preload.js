const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSquadData: () => ipcRenderer.invoke('get-squad-data'),
  getPlayerHistory: (playerId) => ipcRenderer.invoke('get-player-history', playerId),
  triggerRefresh: () => ipcRenderer.invoke('trigger-refresh'),
  getCareerTotals: () => ipcRenderer.invoke('get-career-totals'),
  getManagerPPG: () => ipcRenderer.invoke('get-manager-ppg'),
  getTeamRecordSeasons: () => ipcRenderer.invoke('get-team-record-seasons'),

  onSquadUpdated: (callback) => ipcRenderer.on('squad-updated', (_event, data) => callback(data)),
  onCareerStatsUpdated: (callback) => ipcRenderer.on('career-stats-updated', (_event, data) => callback(data)),
  onTransfersUpdated: (callback) => ipcRenderer.on('transfers-updated', (_event, data) => callback(data)),
  onCalendarUpdated: (callback) => ipcRenderer.on('calendar-updated', (_event, data) => callback(data))
});