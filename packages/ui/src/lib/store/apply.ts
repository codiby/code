import type { SetStateAction } from 'react';

/** Apply a React-style state update (a value or a `prev => next` updater).
 *  Lets store actions expose the exact `useState` setter signature, so call
 *  sites migrate from `useState` to the store without changing handler bodies. */
export const apply = <T>(prev: T, update: SetStateAction<T>): T =>
  typeof update === 'function' ? (update as (p: T) => T)(prev) : update;
