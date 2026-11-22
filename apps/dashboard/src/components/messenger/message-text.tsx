import { Fragment } from "react";
import { tokenizeMessageText } from "../../lib/message-text";

/**
 * Minimal, safe message formatting: line breaks plus clickable http(s)/t.me
 * links. No markdown parser and no HTML injection.
 */
export function MessageText({
  text,
  links = true,
}: {
  text: string;
  links?: boolean;
}) {
  if (!text) return null;
  if (!links) {
    return <p className="whitespace-pre-wrap break-words text-sm">{text}</p>;
  }

  const tokens = tokenizeMessageText(text);
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {tokens.map((token) =>
        token.type === "link" ? (
          <a
            key={`${token.type}:${token.offset}`}
            href={token.href}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => event.stopPropagation()}
            className="underline decoration-current/50 underline-offset-2 hover:decoration-current"
          >
            {token.value}
          </a>
        ) : (
          <Fragment key={`${token.type}:${token.offset}`}>
            {token.value}
          </Fragment>
        ),
      )}
    </p>
  );
}
