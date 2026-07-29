import { defineCustomElement } from 'vue';
import SessionImage from './components/SessionImage.ce.vue';

export const SESSION_IMAGE_TAG = 'obelisk-session-image';

export function registerSessionImageElement() {
  if (customElements.get(SESSION_IMAGE_TAG)) return;
  customElements.define(SESSION_IMAGE_TAG, defineCustomElement(SessionImage));
}
