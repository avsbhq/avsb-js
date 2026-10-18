import { describe, expect, it } from 'vitest'
import { describeErrorDetails, readCompilationErrors, readValidationIssues } from './apiErrorDetails.js'

describe('describeErrorDetails (N4-11: the reason prints in human mode too)', () => {
  it('prints each validation issue as "field: reason"', () => {
    const lines = describeErrorDetails({
      issues: [
        { param: 'key', path: ['key'], code: 'invalid_string', message: 'Key must be lowercase alphanumeric with underscores' },
        { param: 'variations.0.value', path: ['variations', 0, 'value'], code: 'custom', message: 'Expected a number' },
      ],
    })

    expect(lines).toEqual([
      'key: Key must be lowercase alphanumeric with underscores',
      'variations.0.value: Expected a number',
    ])
  })

  it('uses the command labeller for the file, and keeps the field next to it', () => {
    const lines = describeErrorDetails(
      { issues: [{ param: 'editorProjectTs.compiled', path: ['editorProjectTs', 'compiled'], message: 'Required' }] },
      () => 'project.ts',
    )

    expect(lines).toEqual(['project.ts (editorProjectTs.compiled): Required'])
  })

  it('prints compile errors as file:line:col, and the file alone without a position', () => {
    const lines = describeErrorDetails({
      compilationErrors: [
        { file: 'trigger.js', line: 4, column: 2, message: 'Unexpected end of file' },
        { file: 'project.js', line: 0, column: 0, message: 'Cannot be parsed' },
      ],
    })

    expect(lines).toEqual(['trigger.js:4:2: Unexpected end of file', 'project.js: Cannot be parsed'])
  })

  it('names the request body for an issue with no path', () => {
    expect(describeErrorDetails({ issues: [{ param: '', path: [], message: 'Either editorProjectJs or editorProjectTs is required' }] })).toEqual([
      '(request body): Either editorProjectJs or editorProjectTs is required',
    ])
  })

  it('ignores malformed entries rather than printing undefined', () => {
    expect(readValidationIssues({ issues: [null, 'x', { path: ['a'] }, { message: 'ok', path: 'bad' }] })).toEqual([
      { path: [], param: '', message: 'ok' },
    ])
    expect(readCompilationErrors({ compilationErrors: [{ file: 'a.js' }, { message: 'no file' }] })).toEqual([])
    expect(describeErrorDetails(undefined)).toEqual([])
  })
})
