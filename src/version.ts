/**
 * Сведения о сборке, подставляемые бандлером.
 *
 * В Workers нет файловой системы, поэтому версию из package.json нельзя
 * прочитать в рантайме — она вкомпилируется через `define` в wrangler.toml.
 * Значения по умолчанию нужны для тестов и `wrangler dev` без define.
 */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

/** BUILD_VERSION — версия из package.json на момент сборки. */
export const BUILD_VERSION: string = typeof __APP_VERSION__ === 'string'
    ? __APP_VERSION__
    : 'dev';

/** BUILD_COMMIT — короткий хеш коммита, из которого собран воркер. */
export const BUILD_COMMIT: string = typeof __APP_COMMIT__ === 'string'
    ? __APP_COMMIT__
    : 'local';
