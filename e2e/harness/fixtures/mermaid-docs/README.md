# Mermaid fixture

A diagram whose hover style the remote check does not recognize:

```mermaid
%%{init: {"themeCSS": ".node:hover .nodeLabel { --pic: \"https://img.example/hover.png\"; background-image: image-set(var(--pic) 1x); }"}}%%
flowchart TD
  hover[Hover me]
```

A diagram with a remote image node:

```mermaid
flowchart TD
  pic@{ img: "https://img.example/node.png" }
```
