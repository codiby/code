// Ambient module declarations for non-JS assets consumed by the bundler.
// `bun build` handles these at build time; the declarations just keep TS
// from complaining about side-effect imports like `import './global.css'`.

declare module '*.css';
declare module '*.svg';
declare module '*.png';
declare module '*.jpg';
declare module '*.jpeg';
declare module '*.webp';
declare module '*.ico';

// Vite-style env shim for `import.meta.env.PUBLIC_*` (inlined by Bun.build
// via `env: 'PUBLIC_*'`). Kept loose since we only read a couple of keys.
interface ImportMetaEnv {
  readonly PUBLIC_CLAUDE_SERVER_URL?: string;
  readonly PUBLIC_CLAUDE_CWD?: string;
  readonly [key: string]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
