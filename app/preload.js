const { contextBridge, ipcRenderer } = require('electron');

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
});
