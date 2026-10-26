// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { cssUrls, remoteHostsIn } from "./remote-references.js";

function svgWith(markup: string): Element {
  const holder = document.createElement("div");
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${markup}</svg>`;
  document.body.appendChild(holder);
  return holder;
}

describe("remoteHostsIn", () => {
  it.each([
    ["an image element", '<image href="https://img.example/a.png"/>'],
    ["an xlink image", '<image xlink:href="https://img.example/a.png"/>'],
    [
      "an img in a label",
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="https://img.example/a.png"></div></foreignObject>',
    ],
    [
      "a lazily loaded img",
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img loading="lazy" src="//img.example/a.png"></div></foreignObject>',
    ],
    [
      "an img srcset",
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img srcset="docs/a.png 1x, https://img.example/a.png 2x"></div></foreignObject>',
    ],
    ["an external use", '<use href="https://img.example/s.svg#icon"/>'],
    [
      "an inline style",
      '<g style="background-image: url(https://img.example/a.png)"></g>',
    ],
    [
      "a style sheet rule",
      "<style>.node:hover { cursor: url(https://img.example/c.cur), auto; }</style>",
    ],
    [
      "a style sheet import",
      '<style>@import url("https://img.example/x.css");</style>',
    ],
    [
      "a rule nested in a media query",
      "<style>@media screen { .a { background: url('https://img.example/a.png'); } }</style>",
    ],
  ])("finds the host of %s", (_, markup) => {
    expect(remoteHostsIn(svgWith(markup))).toEqual(["img.example"]);
  });

  it.each([
    ["a repo-relative image", '<image href="docs/a.png"/>'],
    ["a data image", '<image href="data:image/png;base64,iVBORw0KGgo="/>'],
    [
      "an in-document reference",
      '<use href="#arrowhead"/><path marker-end="url(#arrowhead)"/>',
    ],
    ["a link", '<a href="https://site.example/page"><text>x</text></a>'],
    ["a fragment paint in CSS", "<style>.a { fill: url(#gradient); }</style>"],
  ])("finds nothing in %s", (_, markup) => {
    expect(remoteHostsIn(svgWith(markup))).toEqual([]);
  });

  it("lists every host once, sorted", () => {
    const root = svgWith(
      '<image href="https://b.example/1.png"/><image href="https://a.example/2.png"/><image href="https://b.example/3.png"/>',
    );
    expect(remoteHostsIn(root)).toEqual(["a.example", "b.example"]);
  });
});

describe("cssUrls", () => {
  it.each([
    ['url("https://img.example/a.png")', ["https://img.example/a.png"]],
    ["url('https://img.example/a.png')", ["https://img.example/a.png"]],
    ["url(https://img.example/a.png)", ["https://img.example/a.png"]],
    ['URL( "a\\"b" )', ['a"b']],
    [
      'url("a.png"), url("https://img.example/b.png")',
      ["a.png", "https://img.example/b.png"],
    ],
    [
      'image-set("https://img.example/a.png" 1x)',
      ["https://img.example/a.png"],
    ],
    ["red", []],
  ])("reads %s", (value, urls) => {
    expect(cssUrls(value)).toEqual(urls);
  });
});
