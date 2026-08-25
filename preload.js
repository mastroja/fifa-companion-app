const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSquadData: (seasonId) => ipcRenderer.invoke('get-squad-data', seasonId),
  getSeasonsList: () => ipcRenderer.invoke('get-seasons-list'),
  getAllTimeSquad: () => ipcRenderer.invoke('get-all-time-squad'),
  getPastPlayers: () => ipcRenderer.invoke('get-past-players'),
  getPlayerHistory: (playerId) => ipcRenderer.invoke('get-player-history', playerId),
  triggerRefresh: () => ipcRenderer.invoke('trigger-refresh'),
  getCareerTotals: () => ipcRenderer.invoke('get-career-totals'),
  getManagerPPG: () => ipcRenderer.invoke('get-manager-ppg'),
  getTeamRecordSeasons: () => ipcRenderer.invoke('get-team-record-seasons'),
  getInferredTransfers: () => ipcRenderer.invoke('get-inferred-transfers'),
  getSavesList: () => ipcRenderer.invoke('get-saves-list'),
  selectSave: (saveId) => ipcRenderer.invoke('select-save', saveId),
  deleteSave: (saveId) => ipcRenderer.invoke('delete-save', saveId),
  getSeasonCompetitionResults: (seasonId) => ipcRenderer.invoke('get-season-competition-results', seasonId),
  getTrophiesWon: () => ipcRenderer.invoke('get-trophies-won'),
  getYouthAcademy: () => ipcRenderer.invoke('get-youth-academy'),

  onSquadUpdated: (callback) => ipcRenderer.on('squad-updated', (_event, data) => callback(data)),
  onCareerStatsUpdated: (callback) => ipcRenderer.on('career-stats-updated', (_event, data) => callback(data)),
  onTransfersUpdated: (callback) => ipcRenderer.on('transfers-updated', (_event, data) => callback(data)),
  onCalendarUpdated: (callback) => ipcRenderer.on('calendar-updated', (_event, data) => callback(data)),
  onYouthUpdated: (callback) => ipcRenderer.on('youth-updated', (_event, data) => callback(data))
});