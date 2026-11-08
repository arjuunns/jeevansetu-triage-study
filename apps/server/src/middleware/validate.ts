import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';

import { ValidationError } from '../lib/errors.js';

type Source = 'body' | 'query' | 'params';

/**
 * Validation middleware factory. Parses and replaces the chosen request segment
 * with the strongly-typed, coerced result. On failure it throws a
 * ValidationError carrying the flattened Zod issues.
 */
export function validate<T extends ZodTypeAny>(schema: T, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(new ValidationError('Request validation failed', result.error.flatten()));
      return;
    }
    // Replace with the parsed value so downstream handlers get coerced types.
    req[source] = result.data as z.infer<T>;
    next();
  };
}
