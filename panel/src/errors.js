'use strict';
// The panel server sends codes, not sentences: the browser translates them into the viewer's language.

class AppError extends Error {
  constructor(code, params = {}, status = 502) {
    super(code);
    this.code = code;
    this.params = params;
    this.status = status;
  }
}

/** The code and params to send to the browser. Other errors come from the game module, in English. */
function describe(e) {
  return e instanceof AppError ? { code: e.code, params: e.params } : { code: 'module_error', params: { detail: e.message } };
}

module.exports = { AppError, describe };
