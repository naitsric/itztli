import { create } from "zustand";
import { api, type AppInfo } from "./backend/api";

/** About the app itself. */
export const useApp = create<{ info: AppInfo | null; remoteImages: boolean }>(() => ({ info: null, remoteImages: false }));

export async function loadAppInfo() {
  const info = await api.appInfo();
  useApp.setState({ info, remoteImages: info.remoteImages });
}

/** Asks the user (in a native dialog) whether notes may load images from the web. */
export async function setRemoteImages(allowed: boolean) {
  useApp.setState({ remoteImages: await api.remoteImagesSet(allowed) });
}
