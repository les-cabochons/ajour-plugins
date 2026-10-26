const pluginIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const pluginVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const connectorFieldTypes = new Set([
  "text",
  "password",
  "url",
  "select",
  "number",
  "checkbox",
]);

function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + " must be an object.");
  }
}

function assertString(value, label, { min = 0, max, trim = false, pattern } = {}) {
  if (typeof value !== "string") {
    throw new Error(label + " must be a string.");
  }

  const checkedValue = trim ? value.trim() : value;
  if (checkedValue.length < min || (max !== undefined && checkedValue.length > max)) {
    throw new Error(label + " length is invalid.");
  }
  if (pattern && !pattern.test(checkedValue)) {
    throw new Error(label + " format is invalid.");
  }
}

function assertOptionalString(value, label, options) {
  if (value !== undefined) {
    assertString(value, label, options);
  }
}

function assertOptionalBoolean(value, label) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(label + " must be a boolean.");
  }
}

function assertOptionalFiniteNumber(value, label) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(label + " must be a finite number.");
  }
}

function assertConnectorFieldValue(value, label) {
  if (
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= 4000)
  ) {
    return;
  }

  throw new Error(label + " is not a valid connector field value.");
}

function assertConnectionField(field, index, capabilities) {
  const label = "connectionFields[" + index + "]";
  assertRecord(field, label);
  assertString(field.id, label + ".id", { min: 1, max: 120, trim: true });
  assertString(field.label, label + ".label", { min: 1, max: 120, trim: true });

  if (typeof field.type !== "string" || !connectorFieldTypes.has(field.type)) {
    throw new Error(label + ".type is invalid.");
  }

  assertOptionalString(field.placeholder, label + ".placeholder", {
    max: 240,
    trim: true,
  });
  assertOptionalString(field.helpText, label + ".helpText", {
    max: 500,
    trim: true,
  });
  assertOptionalBoolean(field.required, label + ".required");
  assertOptionalBoolean(field.secret, label + ".secret");

  if (field.defaultValue !== undefined) {
    assertConnectorFieldValue(field.defaultValue, label + ".defaultValue");
  }

  if (field.options !== undefined) {
    if (!Array.isArray(field.options) || field.options.length > 50) {
      throw new Error(label + ".options is invalid.");
    }

    field.options.forEach((option, optionIndex) => {
      const optionLabel = label + ".options[" + optionIndex + "]";
      assertRecord(option, optionLabel);
      assertString(option.value, optionLabel + ".value", { min: 1, max: 120 });
      assertString(option.label, optionLabel + ".label", { min: 1, max: 120 });
    });
  }

  assertOptionalFiniteNumber(field.min, label + ".min");
  assertOptionalFiniteNumber(field.max, label + ".max");
  assertOptionalFiniteNumber(field.step, label + ".step");

  // The capability the field configures. Ajour hides it while that capability is off.
  if (
    field.capability !== undefined &&
    (!["connector", "codeHost"].includes(field.capability) ||
      capabilities?.[field.capability] === undefined)
  ) {
    throw new Error(label + ".capability must name a capability the plugin declares.");
  }
}

const httpMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const accessChoiceIdPattern = /^[a-z][A-Za-z0-9]{0,39}$/;
const operationPattern = /^[a-z][A-Za-z0-9]{0,62}$/;

// Headers a plugin may never set, whatever its manifest lists, and the prefixes
// of two families. Ajour's broker refuses them, so a manifest that lists one
// never installs.
const deniedRequestHeaders = new Set([
  "authorization",
  "cookie",
  "host",
  "forwarded",
  "x-http-method-override",
  "x-http-method",
  "x-method-override",
  "x-original-url",
  "x-rewrite-url",
  "x-original-host",
  "x-host",
  "x-real-ip",
  "content-length",
  "transfer-encoding",
  "connection",
  "te",
  "upgrade",
  "keep-alive",
  "trailer",
  "expect",
]);
const deniedRequestHeaderPrefixes = ["proxy-", "x-forwarded-"];

/**
 * The connection's access choices (#395): what each connection may do, which
 * the user turns on. Each names the token scope it needs and the operations it
 * unlocks; `always` marks the one that can't be turned off.
 */
function assertConnectionAccess(manifest) {
  const choices = manifest.connectionAccess;
  if (!Array.isArray(choices) || choices.length > 10) {
    throw new Error("Connector manifest connectionAccess must list up to 10 access choices.");
  }
  const ids = new Set();
  choices.forEach((choice, index) => {
    const label = "Connector manifest connectionAccess[" + index + "]";
    assertRecord(choice, label);
    assertString(choice.id, label + ".id", { min: 1, max: 40, pattern: accessChoiceIdPattern });
    if (ids.has(choice.id)) {
      throw new Error(label + ".id is used twice.");
    }
    ids.add(choice.id);
    assertString(choice.label, label + ".label", { min: 1, max: 80, trim: true });
    assertOptionalString(choice.description, label + ".description", { max: 300, trim: true });
    assertString(choice.tokenScope, label + ".tokenScope", { min: 1, max: 200, trim: true });
    assertOptionalBoolean(choice.always, label + ".always");
    if (choice.operations !== undefined) {
      if (!Array.isArray(choice.operations) || choice.operations.length > 50) {
        throw new Error(label + ".operations must list up to 50 operations.");
      }
      choice.operations.forEach((operation, operationIndex) =>
        assertString(operation, label + ".operations[" + operationIndex + "]", { min: 1, max: 63, pattern: operationPattern }),
      );
    }
  });
  return ids;
}

function assertEndpoints(endpoints, label, choiceIds) {
  if (!Array.isArray(endpoints) || endpoints.length < 1 || endpoints.length > 200) {
    throw new Error(label + " must contain 1 to 200 endpoints.");
  }
  endpoints.forEach((endpoint, index) => {
    const endpointLabel = label + "[" + index + "]";
    assertRecord(endpoint, endpointLabel);
    if (!httpMethods.has(endpoint.method)) {
      throw new Error(endpointLabel + ".method is invalid.");
    }
    assertString(endpoint.path, endpointLabel + ".path", { min: 1, max: 500 });
    if (
      !endpoint.path.startsWith("/") ||
      endpoint.path.includes("://") ||
      endpoint.path.includes("?") ||
      endpoint.path.endsWith("/")
    ) {
      throw new Error(endpointLabel + ".path must be a path relative to its host, without a query, such as /_apis/wit/wiql.");
    }
    if (endpoint.access !== undefined && !choiceIds.has(endpoint.access)) {
      throw new Error(endpointLabel + ".access must name one of the manifest's access choices.");
    }
  });
}

/**
 * The part of plugin API 4 this plugin relies on: its requests go through
 * Ajour's broker, which builds the URL from the Organization URL (or a
 * derived host's forms) and attaches the personal access token as Basic
 * credentials with an empty user, so the manifest must name them and the
 * endpoints it calls. Ajour validates the whole manifest again at install.
 */
function assertNetwork(manifest, choiceIds) {
  assertRecord(manifest.network, "Connector manifest network");
  const { auth, baseAddress, endpoints, derivedHosts, requestHeaders } = manifest.network;
  const fields = new Map(manifest.connectionFields.map((field) => [field.id, field]));

  assertRecord(auth, "Connector manifest network.auth");
  if (auth.scheme !== "patBasic") {
    throw new Error("Connector manifest network.auth must use the patBasic scheme.");
  }
  if (fields.get(auth.secretField)?.secret !== true) {
    throw new Error("Connector manifest network.auth.secretField must be a secret connection field.");
  }

  assertRecord(baseAddress, "Connector manifest network.baseAddress");
  if (fields.get(baseAddress.field)?.type !== "url" || fields.get(baseAddress.field).secret === true) {
    throw new Error("Connector manifest network.baseAddress.field must be a url connection field that is not secret.");
  }
  assertOptionalBoolean(baseAddress.allowOnPremises, "Connector manifest network.baseAddress.allowOnPremises");

  assertEndpoints(endpoints, "Connector manifest network.endpoints", choiceIds);

  if (!Array.isArray(derivedHosts) || derivedHosts.length > 10) {
    throw new Error("Connector manifest network.derivedHosts must contain up to 10 derived hosts.");
  }
  const hostIds = new Set();
  derivedHosts.forEach((host, index) => {
    const label = "Connector manifest network.derivedHosts[" + index + "]";
    assertRecord(host, label);
    assertString(host.id, label + ".id", { min: 1, max: 40, pattern: /^[a-z][a-zA-Z0-9-]{0,39}$/ });
    if (hostIds.has(host.id)) {
      throw new Error(label + ".id is used twice.");
    }
    hostIds.add(host.id);
    if (!Array.isArray(host.forms) || host.forms.length < 1 || host.forms.length > 5) {
      throw new Error(label + ".forms must contain 1 to 5 forms.");
    }
    host.forms.forEach((form, formIndex) => {
      const formLabel = label + ".forms[" + formIndex + "]";
      assertRecord(form, formLabel);
      assertString(form.host, formLabel + ".host", { min: 1, max: 253 });
      assertOptionalString(form.whenHost, formLabel + ".whenHost", { min: 1, max: 253 });
      assertOptionalString(form.pathPrefix, formLabel + ".pathPrefix", { min: 1, max: 200 });
      assertOptionalBoolean(form.keepBasePath, formLabel + ".keepBasePath");
      if (form.whenHost === undefined && formIndex !== host.forms.length - 1) {
        throw new Error(formLabel + " must be the last form to leave out whenHost.");
      }
    });
    assertEndpoints(host.endpoints, label + ".endpoints", choiceIds);
  });

  if (!Array.isArray(requestHeaders)) {
    throw new Error("Connector manifest network.requestHeaders must be a list.");
  }
  requestHeaders.forEach((header, index) => {
    assertString(header, "Connector manifest network.requestHeaders[" + index + "]", { min: 1, max: 100 });
    const name = header.toLowerCase();
    if (
      deniedRequestHeaders.has(name) ||
      deniedRequestHeaderPrefixes.some((prefix) => name.startsWith(prefix))
    ) {
      throw new Error("Connector manifest network.requestHeaders may not list " + header + ".");
    }
  });
}

function assertRuntime(manifest) {
  if (manifest.runtime === undefined) return;
  assertRecord(manifest.runtime, "Connector manifest runtime");
  if (manifest.runtime.start !== undefined && !["whenNeeded", "alwaysReady"].includes(manifest.runtime.start)) {
    throw new Error("Connector manifest runtime.start must be whenNeeded or alwaysReady.");
  }
}

export function assertConnectorPluginManifest(manifest) {
  assertRecord(manifest, "Connector manifest");
  assertString(manifest.id, "Connector manifest id", {
    min: 1,
    max: 120,
    trim: true,
    pattern: pluginIdPattern,
  });
  assertString(manifest.version, "Connector manifest version", {
    min: 1,
    trim: true,
    pattern: pluginVersionPattern,
  });

  if (manifest.apiVersion !== 4) {
    throw new Error("Connector manifest API version must be 4.");
  }

  assertRecord(manifest.capabilities, "Connector manifest capabilities");
  const capabilityNames = Object.keys(manifest.capabilities);
  if (
    !capabilityNames.includes("connector") ||
    capabilityNames.some((name) => name !== "connector" && name !== "codeHost")
  ) {
    throw new Error(
      "Connector manifest capabilities must declare connector and may also declare codeHost.",
    );
  }
  for (const name of capabilityNames) {
    assertRecord(manifest.capabilities[name], "Connector manifest capabilities." + name);
  }
  assertOptionalBoolean(
    manifest.capabilities.connector?.settle,
    "Connector manifest capabilities.connector.settle",
  );
  const description = manifest.capabilities.connector?.description;
  if (description !== undefined) {
    assertRecord(description, "Connector manifest capabilities.connector.description");
    assertOptionalBoolean(description.write, "Connector manifest capabilities.connector.description.write");
    if (
      description.maxLength !== undefined &&
      (!Number.isInteger(description.maxLength) || description.maxLength < 1 || description.maxLength > 10_000_000)
    ) {
      throw new Error(
        "Connector manifest capabilities.connector.description.maxLength must be a whole number from 1 to 10,000,000.",
      );
    }
  }

  assertString(manifest.displayName, "Connector manifest displayName", {
    min: 1,
    max: 120,
    trim: true,
  });
  assertOptionalString(manifest.description, "Connector manifest description", {
    max: 500,
    trim: true,
  });
  assertString(manifest.iconSvg, "Connector manifest iconSvg", {
    min: 1,
    max: 20000,
  });
  assertString(manifest.entrypoint, "Connector manifest entrypoint", {
    min: 1,
    max: 240,
    trim: true,
  });

  if (
    !Array.isArray(manifest.connectionFields) ||
    manifest.connectionFields.length < 1 ||
    manifest.connectionFields.length > 50
  ) {
    throw new Error("Connector manifest connectionFields must contain 1 to 50 fields.");
  }

  manifest.connectionFields.forEach((field, index) =>
    assertConnectionField(field, index, manifest.capabilities),
  );
  const choiceIds = assertConnectionAccess(manifest);
  assertNetwork(manifest, choiceIds);
  assertRuntime(manifest);
  return manifest;
}
