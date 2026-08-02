import { defineCustomElement } from 'vue';
import SessionImage from './components/SessionImage.ce.vue';
import { SESSION_IMAGE_TAG } from './session-image-contract.js';

export function registerSessionImageElement() {
  if (customElements.get(SESSION_IMAGE_TAG)) return;
  customElements.define(SESSION_IMAGE_TAG, defineCustomElement(SessionImage));
}
