// Single entry point for i18n; components import from here.
export { getLang, setLang, useLang, useT, t, rt, tr } from "./core";
export type { Lang, Dict, Key, TFn } from "./core";
export {
  dyn, dynList, dynError, datasetLabel, datasetBackground, datasetNote, datasetSource,
} from "./dynamic";
