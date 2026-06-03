# Getting started

wabox connects to WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys),
drops every incoming message into an `inbox/` folder, and watches an `outbox/`
folder for messages to send back. Point any process at those two folders — it
reads new messages from `inbox/` and replies by writing job files to `outbox/`.

## Install

<!--@include: ../README.md#install-->

## Running from a checkout

<!--@include: ../README.md#checkout-->

Next: see the [CLI commands](/cli) you'll use day to day, or read
[how it works](/how-it-works) to understand the inbox/outbox contract.
