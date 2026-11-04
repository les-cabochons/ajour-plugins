// The checks Ajour applies to an API 4 plugin.json when it installs the
// plugin, so a broken manifest fails here instead of in the user's Ajour.
// Reference: Ajour's packages/shared/plugin-api-4.ts.
const pluginIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const pluginVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
const fieldTypes = new Set(["text", "password", "url", "select", "number", "checkbox"]);
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
// The broker's fixed denylist, which a manifest may not list.
const deniedHeaders = new Set(["authorization", "cookie", "host", "forwarded", "content-length"]);

function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + " must be an object.");
  }
}

function assertString(value, label, { min = 0, max, pattern } = {}) {
  if (typeof value !== "string") throw new Error(label + " must be a string.");
  const trimmed = value.trim();
  if (trimmed.length < min || (max !== undefined && trimmed.length > max)) {
    throw new Error(label + " length is invalid.");
  }
  if (pattern && !pattern.test(trimmed)) throw new Error(label + " format is invalid.");
}

function assertOptionalString(value, label, options) {
  if (value !== undefined) assertString(value, label, options);
}

function assertOptionalBoolean(value, label) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(label + " must be a boolean.");
  }
}

function assertConnectionField(field, index) {
  const label = "connectionFields[" + index + "]";
  assertRecord(field, label);
  assertString(field.id, label + ".id", { min: 1, max: 120 });
  assertString(field.label, label + ".label", { min: 1, max: 120 });
  if (!fieldTypes.has(field.type)) throw new Error(label + ".type is invalid.");
  assertOptionalString(field.placeholder, label + ".placeholder", { max: 240 });
  assertOptionalString(field.helpText, label + ".helpText", { max: 500 });
  assertOptionalBoolean(field.required, label + ".required");
  assertOptionalBoolean(field.secret, label + ".secret");
  if (
    field.defaultValue !== undefined &&
    typeof field.defaultValue !== "boolean" &&
    typeof field.defaultValue !== "number" &&
    (typeof field.defaultValue !== "string" || field.defaultValue.length > 4000)
  ) {
    throw new Error(label + ".defaultValue is not a valid connector field value.");
  }
  if (field.secret && field.passToPlugin === true) {
    throw new Error(label + ".passToPlugin: Ajour never passes a secret field to a plugin.");
  }
}

function assertEndpoint(endpoint, label) {
  assertRecord(endpoint, label);
  if (!methods.has(endpoint.method)) throw new Error(label + ".method is invalid.");
  assertString(endpoint.path, label + ".path", { min: 1, max: 500 });
  if (!endpoint.path.startsWith("/") || /^\/\/|:\/\//.test(endpoint.path)) {
    throw new Error(label + ".path must be relative to the base address.");
  }
}

/** The broker's rules a project source plugin's `network` block must follow. */
function assertNetwork(network, fields) {
  assertRecord(network, "network");
  const { auth, baseAddress, endpoints, requestHeaders = [] } = network;

  assertRecord(auth, "network.auth");
  if (auth.scheme !== "headerTemplate") {
    throw new Error("network.auth.scheme must be headerTemplate for a ChronOps personal token.");
  }
  assertString(auth.header, "network.auth.header", { pattern: headerNamePattern });
  if (deniedHeaders.has(auth.header.toLowerCase())) {
    throw new Error("network.auth.header may not set the " + auth.header + " header.");
  }
  assertString(auth.template, "network.auth.template", { min: 1, max: 500 });
  if (auth.template.split("{secret}").length !== 2) {
    throw new Error("network.auth.template holds {secret} exactly once.");
  }
  if (!fields.get(auth.secretField)?.secret) {
    throw new Error("network.auth.secretField must be a secret connection field.");
  }

  assertRecord(baseAddress, "network.baseAddress");
  const addressField = fields.get(baseAddress.field);
  if (!addressField || addressField.type !== "url" || addressField.secret) {
    throw new Error("network.baseAddress.field must be a url connection field that is not secret.");
  }
  assertOptionalBoolean(baseAddress.allowOnPremises, "network.baseAddress.allowOnPremises");

  if (!Array.isArray(endpoints) || endpoints.length < 1 || endpoints.length > 200) {
    throw new Error("network.endpoints must list 1 to 200 endpoints.");
  }
  endpoints.forEach((endpoint, index) => assertEndpoint(endpoint, "network.endpoints[" + index + "]"));

  if (!Array.isArray(requestHeaders) || requestHeaders.length > 30) {
    throw new Error("network.requestHeaders must be an array of at most 30 names.");
  }
  requestHeaders.forEach((header, index) => {
    const label = "network.requestHeaders[" + index + "]";
    assertString(header, label, { pattern: headerNamePattern });
    const name = header.toLowerCase();
    if (deniedHeaders.has(name) || name.startsWith("proxy-") || name.startsWith("x-forwarded-")) {
      throw new Error(label + ": a plugin may not set the " + header + " header.");
    }
    if (name === auth.header.toLowerCase()) {
      throw new Error(label + ": the auth scheme sets the " + header + " header.");
    }
  });
}

export function assertProjectSourcePluginManifest(manifest) {
  assertRecord(manifest, "Plugin manifest");
  assertString(manifest.id, "Plugin manifest id", { min: 1, max: 120, pattern: pluginIdPattern });
  assertString(manifest.version, "Plugin manifest version", { min: 1, pattern: pluginVersionPattern });
  if (manifest.apiVersion !== 4) throw new Error("Plugin manifest API version must be 4.");
  assertString(manifest.displayName, "Plugin manifest displayName", { min: 1, max: 120 });
  assertOptionalString(manifest.description, "Plugin manifest description", { max: 500 });
  assertString(manifest.iconSvg, "Plugin manifest iconSvg", { min: 1, max: 20000 });
  assertString(manifest.entrypoint, "Plugin manifest entrypoint", { min: 1, max: 240 });

  assertRecord(manifest.capabilities, "Plugin manifest capabilities");
  if (Object.keys(manifest.capabilities).join() !== "projectSource") {
    throw new Error("Plugin manifest capabilities must declare projectSource and nothing else.");
  }
  assertRecord(manifest.capabilities.projectSource, "Plugin manifest capabilities.projectSource");

  if (!Array.isArray(manifest.connectionFields) || manifest.connectionFields.length < 1 || manifest.connectionFields.length > 50) {
    throw new Error("Plugin manifest connectionFields must contain 1 to 50 fields.");
  }
  manifest.connectionFields.forEach(assertConnectionField);
  const fields = new Map(manifest.connectionFields.map((field) => [field.id, field]));
  if (fields.size !== manifest.connectionFields.length) {
    throw new Error("Plugin manifest connectionFields must have distinct ids.");
  }
  assertNetwork(manifest.network, fields);
  return manifest;
}
