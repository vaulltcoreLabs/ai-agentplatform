export type AfterCallback = (cb: () => void) => void;

export const after: AfterCallback = (cb) => {
  setImmediate(cb);
};
