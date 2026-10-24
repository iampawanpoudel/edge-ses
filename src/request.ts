import { assertHeaderText, parseMailbox, validateAddressList } from "./address";
import { normalizeAttachment } from "./attachment";
import { SESValidationError } from "./errors";
import type {
  Attachment,
  EmailAddressing,
  EmailHeaders,
  EmailTags,
  RawEmail,
  SendEmailInput,
  SimpleEmail,
  TemplateDefinition,
  TemplateEmail,
} from "./types";
import { bytesToBase64, toBytes } from "./utils";

const MAX_HEADERS = 15;
const MAX_HEADER_NAME = 126;
const MAX_HEADER_VALUE = 995;
const MAX_HEADER_NAME_AND_VALUE = 996;

export interface RequestDefaults {
  defaultTags?: Record<string, string>;
  defaultConfigurationSetName?: string;
}

/**
 * Converts the ergonomic email input into the SES v2 `SendEmail` JSON body.
 * Exported for advanced use and testing; most callers use `sendEmail`.
 */
export function buildSendEmailRequest(
  input: SendEmailInput,
  defaults: RequestDefaults = {},
): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    throw new SESValidationError("sendEmail requires an email object");
  }

  const raw = (input as Partial<RawEmail>).raw;
  const template = (input as Partial<TemplateEmail>).template;
  const simple = input as Partial<SimpleEmail>;
  const hasRaw = raw !== undefined;
  const hasTemplate = template !== undefined;
  const hasSimpleContent =
    simple.subject !== undefined || simple.text !== undefined || simple.html !== undefined;

  if (hasRaw && hasTemplate) {
    throw new SESValidationError("Provide either raw or template content, not both");
  }
  if (hasRaw && hasSimpleContent) {
    throw new SESValidationError("raw email content cannot be combined with subject, text, or html");
  }
  if (hasTemplate && hasSimpleContent) {
    throw new SESValidationError("template content cannot be combined with subject, text, or html");
  }

  const body: Record<string, unknown> = {};

  body.FromEmailAddress = validateFrom(input.from);
  const destination = buildDestination(input);
  if (destination) body.Destination = destination;

  const replyTo = validateAddressList(input.replyTo, "replyTo");
  if (replyTo.length > 0) body.ReplyToAddresses = replyTo;

  assignOptionalString(body, "FromEmailAddressIdentityArn", input.fromIdentityArn, "fromIdentityArn");

  if (input.feedbackForwarding !== undefined) {
    body.FeedbackForwardingEmailAddress = parseMailbox(
      input.feedbackForwarding,
      "feedbackForwarding",
    ).email;
  }
  assignOptionalString(
    body,
    "FeedbackForwardingEmailAddressIdentityArn",
    input.feedbackForwardingIdentityArn,
    "feedbackForwardingIdentityArn",
  );

  const configurationSetName =
    input.configurationSetName !== undefined
      ? input.configurationSetName
      : defaults.defaultConfigurationSetName;
  if (configurationSetName !== undefined) {
    body.ConfigurationSetName = requiredString(configurationSetName, "configurationSetName");
  }

  const tags = buildTags(defaults.defaultTags, input.tags);
  if (tags.length > 0) body.EmailTags = tags;

  if (input.listManagement !== undefined) {
    body.ListManagementOptions = buildListManagement(input.listManagement);
  }

  if (input.configurationOverrides !== undefined) {
    const overrides = buildConfigurationOverrides(input.configurationOverrides);
    if (overrides) body.ConfigurationOverrides = overrides;
  }

  assignOptionalString(body, "TenantName", input.tenantName, "tenantName");
  assignOptionalString(body, "EndpointId", input.endpointId, "endpointId");

  if (hasRaw) {
    body.Content = { Raw: { Data: buildRawContent(raw) } };
  } else if (hasTemplate) {
    body.Content = { Template: buildTemplate(template) };
  } else {
    body.Content = { Simple: buildSimple(simple) };
  }

  if (destination === undefined && !hasRaw) {
    throw new SESValidationError("At least one recipient is required (to, cc, or bcc)");
  }

  return body;
}

function validateFrom(value: unknown): string {
  if (typeof value !== "string") {
    throw new SESValidationError("from is required and must be a string");
  }
  parseMailbox(value, "from");
  return value.trim();
}

function buildDestination(input: EmailAddressing): Record<string, string[]> | undefined {
  const to = validateAddressList(input.to, "to");
  const cc = validateAddressList(input.cc, "cc");
  const bcc = validateAddressList(input.bcc, "bcc");

  if (to.length === 0 && cc.length === 0 && bcc.length === 0) return undefined;

  const destination: Record<string, string[]> = {};
  if (to.length > 0) destination.ToAddresses = to;
  if (cc.length > 0) destination.CcAddresses = cc;
  if (bcc.length > 0) destination.BccAddresses = bcc;
  return destination;
}

function buildSimple(input: Partial<SimpleEmail>): Record<string, unknown> {
  if (typeof input.subject !== "string" || input.subject.trim().length === 0) {
    throw new SESValidationError("subject is required for simple email");
  }
  assertHeaderText(input.subject, "subject");
  if (input.text === undefined && input.html === undefined) {
    throw new SESValidationError("A simple email requires text, html, or both");
  }
  if (input.text !== undefined && typeof input.text !== "string") {
    throw new SESValidationError("text must be a string");
  }
  if (input.html !== undefined && typeof input.html !== "string") {
    throw new SESValidationError("html must be a string");
  }

  const charset = input.charset === undefined ? "UTF-8" : requiredString(input.charset, "charset");
  const body: Record<string, unknown> = {};
  if (input.text !== undefined) body.Text = { Data: input.text, Charset: charset };
  if (input.html !== undefined) body.Html = { Data: input.html, Charset: charset };

  const simple: Record<string, unknown> = {
    Subject: { Data: input.subject, Charset: charset },
    Body: body,
  };

  const headers = buildHeaders(input.headers);
  if (headers.length > 0) simple.Headers = headers;

  const attachments = buildAttachments(input.attachments);
  if (attachments.length > 0) simple.Attachments = attachments;

  return simple;
}

function buildRawContent(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) {
    throw new SESValidationError("raw must be a string, Uint8Array, or ArrayBuffer");
  }
  const bytes = toBytes(value);
  if (bytes.length === 0) {
    throw new SESValidationError("raw email content must not be empty");
  }
  return bytesToBase64(bytes);
}

function buildTemplate(value: string | TemplateDefinition): Record<string, unknown> {
  const definition: TemplateDefinition =
    typeof value === "string" ? { name: value } : (value as TemplateDefinition);

  if (!definition || typeof definition !== "object") {
    throw new SESValidationError("template must be a template name or definition object");
  }

  const name = optionalTrimmedString(definition.name, "template.name");
  const arn = optionalTrimmedString(definition.arn, "template.arn");
  const hasContent = definition.content !== undefined;
  const selectors = [name, arn, hasContent].filter(Boolean).length;

  if (selectors !== 1) {
    throw new SESValidationError(
      "template requires exactly one of name, arn, or content",
    );
  }

  const template: Record<string, unknown> = {};
  if (name) template.TemplateName = name;
  if (arn) template.TemplateArn = arn;

  if (definition.content !== undefined) {
    const content = definition.content;
    if (!content || typeof content !== "object") {
      throw new SESValidationError("template.content must be an object");
    }
    if (typeof content.subject !== "string" || content.subject.trim().length === 0) {
      throw new SESValidationError("template.content.subject is required");
    }
    assertHeaderText(content.subject, "template.content.subject");
    if (content.text === undefined && content.html === undefined) {
      throw new SESValidationError("template.content requires text, html, or both");
    }
    const templateContent: Record<string, unknown> = { Subject: content.subject };
    if (content.text !== undefined) {
      if (typeof content.text !== "string") {
        throw new SESValidationError("template.content.text must be a string");
      }
      templateContent.Text = content.text;
    }
    if (content.html !== undefined) {
      if (typeof content.html !== "string") {
        throw new SESValidationError("template.content.html must be a string");
      }
      templateContent.Html = content.html;
    }
    template.TemplateContent = templateContent;
  }

  if (definition.data !== undefined) {
    template.TemplateData = serializeTemplateData(definition.data);
  }

  const headers = buildHeaders(definition.headers);
  if (headers.length > 0) template.Headers = headers;

  const attachments = buildAttachments(definition.attachments);
  if (attachments.length > 0) template.Attachments = attachments;

  return template;
}

function serializeTemplateData(value: unknown): string {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      throw new SESValidationError("template data must be valid JSON");
    }
    return value;
  }
  if (!value || typeof value !== "object") {
    throw new SESValidationError("template data must be an object or a JSON string");
  }
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("not serializable");
    return json;
  } catch (error) {
    throw new SESValidationError("template data is not JSON-serializable", { cause: error });
  }
}

function buildHeaders(input: EmailHeaders | undefined): Array<{ Name: string; Value: string }> {
  if (input === undefined) return [];

  const entries: Array<{ name: unknown; value: unknown }> = Array.isArray(input)
    ? input.map((header) => ({ name: header?.name, value: header?.value }))
    : Object.entries(input as Record<string, string>).map(([name, value]) => ({ name, value }));

  if (entries.length > MAX_HEADERS) {
    throw new SESValidationError(`A maximum of ${MAX_HEADERS} custom headers is allowed`);
  }

  return entries.map(({ name, value }, index) => {
    if (typeof name !== "string") {
      throw new SESValidationError(`headers[${index}].name must be a string`);
    }
    const headerName = name.trim();
    if (!/^[\x21-\x39\x3B-\x7E]+$/.test(headerName) || headerName.length > MAX_HEADER_NAME) {
      throw new SESValidationError(
        `headers[${index}].name must be 1-${MAX_HEADER_NAME} printable ASCII characters other than ":"`,
      );
    }
    if (headerName.toLowerCase() === "bcc") {
      throw new SESValidationError('Use the bcc option instead of a Bcc header, so Bcc stays envelope-only');
    }
    if (typeof value !== "string") {
      throw new SESValidationError(`headers[${index}].value must be a string`);
    }
    if (!/^[ -~]+$/.test(value) || value.length > MAX_HEADER_VALUE) {
      throw new SESValidationError(
        `headers[${index}].value must be 1-${MAX_HEADER_VALUE} printable ASCII characters`,
      );
    }
    if (headerName.length + value.length > MAX_HEADER_NAME_AND_VALUE) {
      throw new SESValidationError(
        `headers[${index}] name and value combined must not exceed ${MAX_HEADER_NAME_AND_VALUE} characters`,
      );
    }
    return { Name: headerName, Value: value };
  });
}

function buildAttachments(input: Attachment[] | undefined): Array<Record<string, unknown>> {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new SESValidationError("attachments must be an array");
  }

  return input.map((attachment, index) => {
    const normalized = normalizeAttachment(attachment, `attachments[${index}]`);
    const encodings: Record<string, string> = {
      base64: "BASE64",
      "quoted-printable": "QUOTED_PRINTABLE",
      "7bit": "SEVEN_BIT",
    };
    const result: Record<string, unknown> = {
      FileName: normalized.filename,
      RawContent: bytesToBase64(normalized.bytes),
      ContentDisposition: normalized.disposition.toUpperCase(),
      // SES defaults to SEVEN_BIT, which corrupts binary attachments.
      ContentTransferEncoding: encodings[normalized.transferEncoding ?? "base64"],
    };

    if (normalized.contentType !== undefined) {
      result.ContentType = normalized.contentType;
    }
    if (normalized.contentId !== undefined) {
      result.ContentId = normalized.contentId;
    }
    if (normalized.description !== undefined) {
      result.ContentDescription = normalized.description;
    }

    return result;
  });
}

function buildTags(
  defaults: Record<string, string> | undefined,
  input: EmailTags | undefined,
): Array<{ Name: string; Value: string }> {
  const merged = new Map<string, string>();

  const addEntries = (entries: Array<{ name: unknown; value: unknown }>) => {
    for (const { name, value } of entries) {
      if (typeof name !== "string" || typeof value !== "string") {
        throw new SESValidationError("tags must contain string names and values");
      }
      if (name.length === 0 || name.length > 256) {
        throw new SESValidationError("tag names must be 1-256 characters");
      }
      if (value.length > 256) {
        throw new SESValidationError("tag values must be at most 256 characters");
      }
      assertHeaderText(name, "tag name");
      assertHeaderText(value, "tag value");
      merged.set(name, value);
    }
  };

  if (defaults !== undefined) {
    addEntries(Object.entries(defaults).map(([name, value]) => ({ name, value })));
  }
  if (input !== undefined) {
    addEntries(
      Array.isArray(input)
        ? input.map((tag) => ({ name: tag?.name, value: tag?.value }))
        : Object.entries(input as Record<string, string>).map(([name, value]) => ({ name, value })),
    );
  }

  return [...merged].map(([Name, Value]) => ({ Name, Value }));
}

function buildListManagement(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    throw new SESValidationError("listManagement must be an object");
  }
  const options = value as { contactListName?: unknown; topicName?: unknown };
  const contactListName = requiredString(options.contactListName, "listManagement.contactListName");
  const result: Record<string, string> = { ContactListName: contactListName };
  if (options.topicName !== undefined) {
    result.TopicName = requiredString(options.topicName, "listManagement.topicName");
  }
  return result;
}

function buildConfigurationOverrides(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    throw new SESValidationError("configurationOverrides must be an object");
  }
  const overrides = value as { tracking?: unknown };
  if (overrides.tracking === undefined) return undefined;

  if (!overrides.tracking || typeof overrides.tracking !== "object") {
    throw new SESValidationError("configurationOverrides.tracking must be an object");
  }
  const tracking = overrides.tracking as {
    clickTrackingEnabled?: unknown;
    openTrackingEnabled?: unknown;
  };
  const result: Record<string, string> = {};
  if (tracking.clickTrackingEnabled !== undefined) {
    result.ClickTrackingEnabled = trackingState(
      tracking.clickTrackingEnabled,
      "configurationOverrides.tracking.clickTrackingEnabled",
    );
  }
  if (tracking.openTrackingEnabled !== undefined) {
    result.OpenTrackingEnabled = trackingState(
      tracking.openTrackingEnabled,
      "configurationOverrides.tracking.openTrackingEnabled",
    );
  }
  return Object.keys(result).length > 0 ? { Tracking: result } : undefined;
}

function trackingState(value: unknown, field: string): "ENABLED" | "DISABLED" {
  if (value !== "ENABLED" && value !== "DISABLED") {
    throw new SESValidationError(`${field} must be "ENABLED" or "DISABLED"`);
  }
  return value;
}

function assignOptionalString(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  field: string,
): void {
  if (value === undefined) return;
  target[key] = requiredString(value, field);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SESValidationError(`${field} must be a non-empty string`);
  }
  assertHeaderText(value, field);
  return value.trim();
}

function optionalTrimmedString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}
