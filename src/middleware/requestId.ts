/**
 * Assigns a correlation id to every request and echoes it as X-Request-Id.
 *
 * Every log line for a request carries this id, so tracing "what happened on that
 * failed checkout" is a single grep. Honours an inbound X-Request-Id so a trace
 * can span the frontend and the API.
 */
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

/** Reject absurd inbound values — this ends up in log lines and a response header. */
const MAX_INBOUND_LENGTH = 128;
const SAFE_ID = /^[\w.:-]+$/;

export const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.get('x-request-id');
  const id =
    inbound && inbound.length <= MAX_INBOUND_LENGTH && SAFE_ID.test(inbound)
      ? inbound
      : randomUUID();

  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
};
