import { useEffect, useRef, useState } from "react";
import type {
  PetAttention,
  PetAttentionResponse,
  PetFormField,
  PetFormValue,
} from "../../../contracts/desktop-pet-attention";
import { petApi } from "../../bridge/pet-api";
import { Icon } from "../components/Icon";
import { petMessages } from "./messages";
import { usePatchSummary } from "./use-patch-summary";
import {
  questionResponse,
  initialFormValues,
  canSubmitQuestion,
} from "./attention-model";
import type { PetComposerAttachment } from "../../../contracts/desktop-pet-composer";

function Field({
  name,
  scope,
  field,
  value,
  required,
  disabled,
  change,
}: {
  name: string;
  scope: string;
  field: PetFormField;
  value?: PetFormValue;
  required: boolean;
  disabled: boolean;
  change: (value: PetFormValue) => void;
}) {
  const choices =
    field.oneOf?.map((item) => ({
      value: item.const,
      label: item.title ?? String(item.const),
    })) ??
    field.enum?.map((item, index) => ({
      value: item,
      label: field.enumNames?.[index] ?? String(item),
    }));
  const id = `pet-field-${scope}-${name}`;
  const [arrayDraft, setArrayDraft] = useState(
    Array.isArray(value) ? value.join(", ") : "",
  );
  return (
    <div className="pet-attention-field">
      <label htmlFor={id}>
        {field.title || name}
        {required && <b aria-hidden="true"> *</b>}
      </label>
      {field.description && <small>{field.description}</small>}
      {field.type === "boolean" ? (
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          checked={value === true}
          onChange={(event) => change(event.target.checked)}
        />
      ) : field.type === "array" ? (
        <div
          className="pet-form-checkboxes"
          role="group"
          aria-label={field.title || name}
        >
          {!field.items?.enum && !field.items?.oneOf && (
            <input
              id={id}
              type="text"
              disabled={disabled}
              required={required}
              value={arrayDraft}
              onChange={(event) => {
                setArrayDraft(event.target.value);
                change(
                  event.target.value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                );
              }}
            />
          )}
          {(
            field.items?.oneOf?.map((option) => ({
              value: option.const,
              label: option.title || option.const,
            })) ??
            field.items?.enum?.map((option) => ({
              value: option,
              label: option,
            })) ??
            []
          ).map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={Array.isArray(value) && value.includes(option.value)}
                onChange={(event) => {
                  const current = Array.isArray(value) ? value : [];
                  change(
                    event.target.checked
                      ? [...current, option.value]
                      : current.filter((item) => item !== option.value),
                  );
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      ) : choices ? (
        <select
          id={id}
          disabled={disabled}
          required={required}
          value={String(value ?? "")}
          onChange={(event) => {
            const choice = choices.find(
              (item) => String(item.value) === event.target.value,
            );
            change(choice?.value ?? "");
          }}
        >
          <option value="" />
          {choices.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          disabled={disabled}
          required={required}
          type={
            field.type === "number" || field.type === "integer"
              ? "number"
              : field.format === "email"
                ? "email"
                : field.format === "uri"
                  ? "url"
                  : "text"
          }
          step={
            field.type === "integer"
              ? 1
              : field.type === "number"
                ? "any"
                : undefined
          }
          min={field.minimum}
          max={field.maximum}
          minLength={field.minLength}
          maxLength={field.maxLength}
          value={
            typeof value === "string" || typeof value === "number" ? value : ""
          }
          onChange={(event) =>
            change(
              field.type === "number" || field.type === "integer"
                ? event.target.value === ""
                  ? ""
                  : Number(event.target.value)
                : event.target.value,
            )
          }
        />
      )}
    </div>
  );
}
export function AttentionControls({
  attention,
  taskId,
  language,
  onError,
}: {
  attention: PetAttention;
  taskId: string;
  language: "en" | "zh";
  onError: (error: unknown) => void;
}) {
  const m = petMessages(language);
  const [pending, setPending] = useState(false);
  const [persistApp, setPersistApp] = useState(false);
  const [suggestions, setSuggestions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>(
    attention.kind === "question" ? (attention.answers ?? {}) : {},
  );
  const [multiple, setMultiple] = useState<Record<string, string[]>>({});
  const [values, setValues] = useState<Record<string, PetFormValue>>(
    attention.kind === "mcp-form" ? initialFormValues(attention) : {},
  );
  const [questionFiles, setQuestionFiles] = useState<
    Record<string, PetComposerAttachment[]>
  >({});
  const [attachmentBusy, setAttachmentBusy] = useState<string | null>(null);
  const questionFilesRef = useRef<Record<string, PetComposerAttachment[]>>({});
  const mounted = useRef(true);
  const releaseQuestionFiles = () => {
    const ids = new Set(
      Object.values(questionFilesRef.current)
        .flat()
        .map((file) => file.id),
    );
    questionFilesRef.current = {};
    if (mounted.current) setQuestionFiles({});
    void Promise.allSettled([...ids].map((id) => petApi.removeAttachment(id)));
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      releaseQuestionFiles();
    };
  }, []);
  const pickQuestionFiles = async (question: string) => {
    if (
      attention.kind !== "question" ||
      !attention.attachmentsSupported ||
      pending ||
      attachmentBusy
    )
      return;
    setAttachmentBusy(question);
    try {
      const picked = await petApi.pickAttachments();
      if (!mounted.current) {
        void Promise.allSettled(
          picked.map((file) => petApi.removeAttachment(file.id)),
        );
        return;
      }
      const current = questionFilesRef.current[question] ?? [];
      const next = {
        ...questionFilesRef.current,
        [question]: [
          ...current,
          ...picked.filter(
            (file) => !current.some((existing) => existing.id === file.id),
          ),
        ],
      };
      questionFilesRef.current = next;
      setQuestionFiles(next);
    } catch (error) {
      onError(error);
    } finally {
      if (mounted.current) setAttachmentBusy(null);
    }
  };
  const removeQuestionFile = async (question: string, id: string) => {
    if (pending || attachmentBusy) return;
    setAttachmentBusy(question);
    try {
      const next = {
        ...questionFilesRef.current,
        [question]: (questionFilesRef.current[question] ?? []).filter(
          (file) => file.id !== id,
        ),
      };
      if (
        !Object.values(next).some((files) =>
          files.some((file) => file.id === id),
        )
      )
        await petApi.removeAttachment(id);
      questionFilesRef.current = next;
      if (mounted.current) setQuestionFiles(next);
    } catch (error) {
      onError(error);
    } finally {
      if (mounted.current) setAttachmentBusy(null);
    }
  };
  const attachmentIds = Object.fromEntries(
    Object.entries(questionFiles).map(([question, files]) => [
      question,
      files.map((file) => file.id),
    ]),
  );
  const send = async (response: PetAttentionResponse) => {
    if (pending || attachmentBusy) return;
    setPending(true);
    try {
      await petApi.respondTask({ taskId, requestId: attention.id, response });
      if ("kind" in response && response.kind === "open") setPending(false);
      else releaseQuestionFiles();
    } catch (error) {
      onError(error);
      setPending(false);
    }
  };
  const busy =
    pending ||
    Boolean(attachmentBusy) ||
    (attention.kind === "question" && attention.state === "submitting");
  const changeSummary = usePatchSummary(attention);
  const changes = changeSummary.summary;
  if (attention.kind === 'review') return <section className="pet-attention" data-request-id={attention.id}>
    <p>{attention.message || (attention.reason === 'unsupported-schema' ? m.reviewUnsupported : attention.reason === 'high-risk' ? m.reviewHighRisk : m.reviewVerification)}</p>
    <button className="primary" onClick={() => petApi.openTask(taskId).catch(onError)}>{m.review}<Icon name="arrow-up-right" size={12} /></button>
  </section>;
  if (attention.kind === "approval")
    return (
      <section className="pet-attention" data-request-id={attention.id}>
        {attention.message && <p>{attention.message}</p>}
        {changeSummary.pending && <p role="status">{m.calculatingChanges}</p>}
        {changeSummary.error && <p role="alert">{changeSummary.error}</p>}
        {changes && (
          <div className="pet-patch-summary">
            {changes.firstPath && <strong>{changes.firstPath}</strong>}
            <span>
              {changes.fileCount}{" "}
              {changes.fileCount === 1 ? m.changedFile : m.changedFiles}
            </span>
            <span className="pet-patch-additions">+{changes.additions}</span>
            <span className="pet-patch-deletions">−{changes.deletions}</span>
          </div>
        )}
        {attention.command && (
          <pre className="pet-command">{attention.command}</pre>
        )}
        {attention.cwd && (
          <small className="pet-attention-path">{attention.cwd}</small>
        )}
        {attention.paths?.map((path) => (
          <code className="pet-attention-path" key={path}>
            {path}
          </code>
        ))}
        {attention.domains?.map((domain) => (
          <code className="pet-attention-path" key={domain}>
            {domain}
          </code>
        ))}
        {attention.fileChanges?.length ? (
          <details className="pet-attention-details">
            <summary>
              {m.review} · {attention.fileChanges.length}
            </summary>
            {attention.fileChanges.map((change) => (
              <div key={change.path}>
                <strong>{change.path}</strong>
                <pre>
                  {change.diff ??
                    `${change.oldText ?? ""}\n→\n${change.newText ?? ""}`}
                </pre>
              </div>
            ))}
          </details>
        ) : null}
        {attention.patch && (
          <details className="pet-attention-details">
            <summary>{m.review}</summary>
            <pre>{attention.patch}</pre>
          </details>
        )}
        {attention.plan && (
          <details className="pet-attention-details">
            <summary>{m.details}</summary>
            <pre>{attention.plan}</pre>
          </details>
        )}
        {attention.suggestions?.length ? (
          <fieldset disabled={busy}>
            <legend>{m.remember}</legend>
            {attention.suggestions.map((suggestion) => (
              <label
                className="pet-permission-suggestion"
                key={suggestion.index}
              >
                <input
                  type="checkbox"
                  checked={suggestions.includes(suggestion.index)}
                  onChange={(event) =>
                    setSuggestions((current) =>
                      event.target.checked
                        ? [...current, suggestion.index]
                        : current.filter((index) => index !== suggestion.index),
                    )
                  }
                />
                <span>
                  {suggestion.label}
                  {suggestion.destination && (
                    <small>{suggestion.destination}</small>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="pet-attention-actions">
          <button
            disabled={busy}
            onClick={() => void send({ decision: "deny" })}
          >
            {m.deny}
          </button>
          <button
            disabled={busy}
            onClick={() => petApi.openTask(taskId).catch(onError)}
          >
            {m.review}
            <Icon name="arrow-up-right" size={12} />
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void send({
                decision: "allow",
                ...(suggestions.length
                  ? { acceptedSuggestionIndices: suggestions }
                  : {}),
              })
            }
          >
            {busy ? (
              <Icon name="chat-scroll-to-bottom-spin" size={14} />
            ) : attention.category === "patch" ? (
              m.apply
            ) : attention.category === "plan" ? (
              m.implement
            ) : (
              m.allow
            )}
          </button>
        </div>
      </section>
    );
  if (attention.kind === "question")
    return (
      <form
        className="pet-attention"
        data-request-id={attention.id}
        onSubmit={(event) => {
          event.preventDefault();
          void send(questionResponse(attention, answers, attachmentIds));
        }}
      >
        {attention.questions.map((question, index) => (
          <fieldset disabled={busy} key={`${index}:${question.question}`}>
            <legend>{question.header || question.question}</legend>
            {question.header && <p>{question.question}</p>}
            <div className="pet-question-options">
              {question.options.map((option) => (
                <label key={option.label}>
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`pet-question-${attention.id}-${index}`}
                    checked={
                      question.multiSelect
                        ? (multiple[question.question] ?? []).includes(
                            option.label,
                          )
                        : answers[question.question] === option.label
                    }
                    onChange={(event) => {
                      if (question.multiSelect) {
                        const current = multiple[question.question] ?? [],
                          next = event.target.checked
                            ? [...current, option.label]
                            : current.filter((value) => value !== option.label);
                        setMultiple((current) => ({
                          ...current,
                          [question.question]: next,
                        }));
                        setAnswers((current) => ({
                          ...current,
                          [question.question]: next.join(", "),
                        }));
                      } else
                        setAnswers((current) => ({
                          ...current,
                          [question.question]: option.label,
                        }));
                    }}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                    {option.preview && <pre>{option.preview}</pre>}
                  </span>
                </label>
              ))}
            </div>
            {question.allowFreeform !== false && (
              <input
                aria-label={`${m.freeform}: ${question.question}`}
                placeholder={m.freeform}
                value={
                  question.options.some(
                    (option) => option.label === answers[question.question],
                  ) ||
                  (question.multiSelect &&
                    answers[question.question] ===
                      (multiple[question.question] ?? []).join(", "))
                    ? ""
                    : (answers[question.question] ?? "")
                }
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.question]: event.target.value,
                  }))
                }
              />
            )}
            {attention.attachmentsSupported && (
              <div className="pet-question-attachments">
                <button
                  className="pet-question-attach"
                  type="button"
                  disabled={busy}
                  onClick={() => void pickQuestionFiles(question.question)}
                >
                  <Icon name="tc-attachment" size={14} />
                  {attachmentBusy === question.question
                    ? m.attachmentAdding
                    : m.attachFiles}
                </button>
                {(questionFiles[question.question]?.length ?? 0) > 0 && (
                  <div
                    className="pet-attachment-list"
                    role="list"
                    aria-label={`${m.attachments}: ${question.question}`}
                  >
                    {questionFiles[question.question].map((file) => (
                      <div
                        className="pet-attachment-chip"
                        role="listitem"
                        key={file.id}
                      >
                        {file.previewUrl ? (
                          <img src={file.previewUrl} alt="" />
                        ) : (
                          <Icon name="file" size={17} />
                        )}
                        <span>
                          <strong>{file.name}</strong>
                          <small>
                            {file.size < 1024
                              ? `${file.size} B`
                              : `${Math.ceil(file.size / 1024)} KB`}
                          </small>
                        </span>
                        <button
                          type="button"
                          disabled={busy}
                          aria-label={`${m.attachmentRemove}: ${file.name}`}
                          onClick={() =>
                            void removeQuestionFile(question.question, file.id)
                          }
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </fieldset>
        ))}
        <div className="pet-attention-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void send({ kind: "cancel" })}
          >
            {m.cancel}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={
              busy || !canSubmitQuestion(attention, answers, attachmentIds)
            }
          >
            {m.answer}
          </button>
        </div>
      </form>
    );
  if (attention.kind === "mcp-form")
    return (
      <form
        className="pet-attention"
        data-request-id={attention.id}
        onSubmit={(event) => {
          event.preventDefault();
          void send({
            kind: "accept",
            values,
            ...(attention.computerUseApp ? { persistApp } : {}),
          });
        }}
      >
        {attention.serverName && <strong>{attention.serverName}</strong>}
        {attention.message && <p>{attention.message}</p>}
        {Object.entries(attention.schema.properties).map(([name, field]) => (
          <Field
            key={name}
            name={name}
            scope={attention.id}
            field={field}
            value={values[name]}
            required={attention.schema.required?.includes(name) ?? false}
            disabled={busy}
            change={(value) =>
              setValues((current) => ({ ...current, [name]: value }))
            }
          />
        ))}
        {attention.computerUseApp && (
          <label className="pet-permission-suggestion">
            <input
              type="checkbox"
              checked={persistApp}
              onChange={(event) => setPersistApp(event.target.checked)}
              disabled={busy}
            />
            <span>
              {m.remember}: {attention.computerUseApp}
            </span>
          </label>
        )}
        <div className="pet-attention-actions">
          <button
            disabled={busy}
            type="button"
            onClick={() => void send({ kind: "decline" })}
          >
            {m.decline}
          </button>
          <button disabled={busy} className="primary" type="submit">
            {m.accept}
          </button>
        </div>
      </form>
    );
  return (
    <section className="pet-attention" data-request-id={attention.id}>
      {attention.serverName && <strong>{attention.serverName}</strong>}
      {attention.message && <p>{attention.message}</p>}
      <code className="pet-attention-path">{attention.url}</code>
      <div className="pet-attention-actions">
        <button disabled={busy} onClick={() => void send({ kind: "decline" })}>
          {m.cancel}
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void send({ kind: "open" })}
        >
          {m.continue}
          <Icon name="arrow-up-right" size={12} />
        </button>
      </div>
    </section>
  );
}
