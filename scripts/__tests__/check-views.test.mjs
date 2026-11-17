import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkTemplate, isLayout, listTemplates, stripComments } from '../check-views.mjs';

const messages = (source) => checkTemplate(source).map((finding) => finding.message.split(' ')[0]);

describe('check-views', () => {
  it('B-01: rejects triple-stash output, also with whitespace control', () => {
    expect(messages('<p>{{{bio}}}</p>')).toEqual(['unescaped']);
    expect(messages('<p>{{~{bio}~}}</p>')).toEqual(['unescaped']);
    expect(messages('<p>{{bio}}</p>')).toEqual([]);
  });

  it('B-01: rejects the ampersand form of unescaped output, also with whitespace control', () => {
    expect(messages('<p>{{&bio}}</p>')).toEqual(['unescaped']);
    expect(messages('<p>{{& petition.comment}}</p>')).toEqual(['unescaped']);
    expect(messages('<p>{{~&bio~}}</p>')).toEqual(['unescaped']);
    expect(messages('<p>{{#if a}}&amp;{{/if}}</p>')).toEqual([]);
  });

  it('B-01: allows only the exact body slot {{{body}}}, and only in layouts', () => {
    const layout = { layout: true };

    expect(messages('<main>{{{body}}}</main>')).toEqual(['unescaped']);
    expect(checkTemplate('<main>{{{body}}}</main>', layout)).toEqual([]);
    expect(checkTemplate('<main>\n  {{{body}}}\n  {{{bio}}}</main>', layout)).toEqual([
      { line: 3, column: 3, message: expect.stringContaining('unescaped output') },
    ]);
    expect(checkTemplate('<main>{{{ body }}}{{~{body}~}}{{{body.x}}}{{&body}}</main>', layout)).toHaveLength(4);
  });

  it('B-01: treats only files directly in <views>/layouts as layouts', () => {
    const dir = join('/views');

    expect(isLayout(dir, join(dir, 'layouts', 'main.hbs'))).toBe(true);
    expect(isLayout(dir, join(dir, 'pages', 'home.hbs'))).toBe(false);
    expect(isLayout(dir, join(dir, 'pages', 'layouts', 'x.hbs'))).toBe(false);
    expect(isLayout(dir, join(dir, 'layouts.hbs'))).toBe(false);
  });

  it('B-17: rejects target="_blank" in any quoting', () => {
    expect(messages('<a href="/x" target="_blank">x</a>')).toEqual(['target="_blank"']);
    expect(messages("<a href='/x' TARGET='_blank'>x</a>")).toEqual(['target="_blank"']);
    expect(messages('<a href="/x" target=_blank>x</a>')).toEqual(['target="_blank"']);
    expect(messages('<a href="/x" target="_self">x</a>')).toEqual([]);
  });

  it('F-71: rejects inline styles and <style> elements', () => {
    expect(messages('<div class="row" style="color: red">x</div>')).toEqual(['inline']);
    expect(messages('<style>p { color: red; }</style>')).toEqual(['<style>']);
    expect(messages('<div data-style="compact" class="x">x</div>')).toEqual([]);
  });

  it('F-71: rejects inline scripts and event handlers but allows module scripts with src', () => {
    expect(messages('<script>alert(1)</script>')).toEqual(['inline']);
    expect(messages('<script type="module">import "/x.js";</script>')).toEqual(['inline']);
    expect(messages('<button onclick="go()">go</button>')).toEqual(['inline']);
    expect(messages('<script type="module" src="{{asset \'form-guard.js\'}}"></script>')).toEqual([]);
    expect(messages('<p>Sign on=the line</p>')).toEqual([]);
  });

  it('B-01: ignores banned constructs inside Handlebars comments and keeps positions', () => {
    const source = '{{!-- never use {{{ or style="" --}}\n{{! target="_blank" }}\n<p>\n  {{{raw}}}</p>';

    expect(stripComments(source).split('\n')).toHaveLength(4);
    expect(checkTemplate(source)).toEqual([
      { line: 4, column: 3, message: expect.stringContaining('unescaped output') },
    ]);
  });

  it('B-01: finds .hbs files in nested folders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-views-'));
    try {
      mkdirSync(join(dir, 'pages', 'auth'), { recursive: true });
      writeFileSync(join(dir, 'pages', 'auth', 'login.hbs'), '');
      writeFileSync(join(dir, 'home.hbs'), '');
      writeFileSync(join(dir, 'notes.txt'), '');

      expect(listTemplates(dir).map((file) => file.slice(dir.length + 1))).toEqual([
        'home.hbs',
        join('pages', 'auth', 'login.hbs'),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
