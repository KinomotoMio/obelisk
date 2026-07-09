import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('obelisk', {
  getSessions: (opts) => ipcRenderer.invoke('db:getSessions', opts),
  getSessionMessages: (id) => ipcRenderer.invoke('db:getSessionMessages', id),
  getSessionToolCalls: (id) => ipcRenderer.invoke('db:getSessionToolCalls', id),
  getSessionToolResults: (id) => ipcRenderer.invoke('db:getSessionToolResults', id),
  getSessionSubagents: (id) => ipcRenderer.invoke('db:getSessionSubagents', id),
  getSessionWorkflows: (id) => ipcRenderer.invoke('db:getSessionWorkflows', id),
  getSubagentMessages: (agentId) => ipcRenderer.invoke('db:getSubagentMessages', agentId),
  getSubagentToolCalls: (agentId) => ipcRenderer.invoke('db:getSubagentToolCalls', agentId),
  getSubagentToolResults: (agentId) => ipcRenderer.invoke('db:getSubagentToolResults', agentId),
  getSessionSummaries: (id) => ipcRenderer.invoke('db:getSessionSummaries', id),
  getMessageFullText: (uuid) => ipcRenderer.invoke('db:getMessageFullText', uuid),
  getMemories: () => ipcRenderer.invoke('db:getMemories'),
  readMemoryFile: (path) => ipcRenderer.invoke('db:readMemoryFile', path),
  archiveMemory: (id, reason) => ipcRenderer.invoke('db:archiveMemory', id, reason),
  restoreMemory: (id) => ipcRenderer.invoke('db:restoreMemory', id),
  getProjects: () => ipcRenderer.invoke('db:getProjects'),
  getStats: () => ipcRenderer.invoke('db:getStats'),
  getUsageStats: () => ipcRenderer.invoke('db:getUsageStats'),
  onIndexUpdated: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('obelisk:index-updated', listener);
    return () => ipcRenderer.removeListener('obelisk:index-updated', listener);
  },
  onSessionUpdated: (callback) => {
    const listener = (_, payload) => callback(payload);
    ipcRenderer.on('obelisk:session-updated', listener);
    return () => ipcRenderer.removeListener('obelisk:session-updated', listener);
  },
  captureExport: (opts) => ipcRenderer.invoke('capture:export', opts),
  copyImage: (opts) => ipcRenderer.invoke('capture:copy', opts),
  recapList: () => ipcRenderer.invoke('recap:list'),
  recapRead: (filename) => ipcRenderer.invoke('recap:read', filename),
  onRecapUpdated: (callback) => {
    const listener = (_, filePath) => callback(filePath);
    ipcRenderer.on('obelisk:recap-updated', listener);
    return () => ipcRenderer.removeListener('obelisk:recap-updated', listener);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  browseFolder: () => ipcRenderer.invoke('settings:browseFolder'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  revealPath: (p) => ipcRenderer.invoke('settings:revealPath', p),
  rebuildIndex: () => ipcRenderer.invoke('settings:rebuildIndex'),
});
