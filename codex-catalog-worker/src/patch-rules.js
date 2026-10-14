// Rules apply to the catalog at request time. Upstream files are not modified.
export const RULES = {
  disableResponsesLite: true,

  // Optional patch applied to each model. Nested objects merge; arrays replace.
  allModels: {},

  models: {
    "gpt-6.1-sol": { context_window: 500000 },
    "gpt-6-astra": { context_window: 300000 },
    "gpt-5.6-sol": { context_window: 300000 },
  },

  // Optional exact-version rules, applied after the common rules.
  // "0.162.1": { allModels: {}, models: { "model-slug": { field: value } } }
  versions: {},

  // Optional mapping for a client version with no matching stable release tag.
  // "0.163.0": "rust-v0.163.0-alpha.1"
  versionRefs: {},
};
