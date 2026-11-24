/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by `pnpm dev:web`: the development server's address, token included. */
  readonly VITE_DEV_BACKEND?: string;
}
