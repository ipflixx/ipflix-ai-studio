import type { IpflixDesktopBridge } from '../../electron/preload';
import type { IpflixAndroidBridge } from '../services/androidBridge';

declare global {
  interface Window {
    ipflixDesktop?: IpflixDesktopBridge;
    ipflixAndroid?: IpflixAndroidBridge;
  }
}

export {};
