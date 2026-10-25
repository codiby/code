/// <reference types="nativewind/types" />

// Metro resuelve el CSS vía nativewind/metro; TS necesita el módulo declarado
// para aceptar `import './global.css'` como side-effect import.
declare module '*.css';
