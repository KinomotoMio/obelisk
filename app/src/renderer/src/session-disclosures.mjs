import { reactive } from 'vue';

export function createSessionDisclosureState() {
  const entries = reactive(new Map());

  function update(key, messageUuid, field) {
    const current = entries.get(key) || { messageUuid, open: false, raw: false };
    const next = { ...current, messageUuid, [field]: !current[field] };
    if (!next.open && !next.raw) entries.delete(key);
    else entries.set(key, next);
  }

  return {
    isOpen(key) {
      return Boolean(entries.get(key)?.open);
    },
    isRaw(key) {
      return Boolean(entries.get(key)?.raw);
    },
    toggleOpen(key, messageUuid) {
      update(key, messageUuid, 'open');
    },
    toggleRaw(key, messageUuid) {
      update(key, messageUuid, 'raw');
    },
    retainMessages(messageUuids) {
      for (const [key, entry] of entries) {
        if (!messageUuids.has(entry.messageUuid)) entries.delete(key);
      }
    },
  };
}
