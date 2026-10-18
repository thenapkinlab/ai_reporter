# Security

This gateway handles access to people's email, so security reports are very welcome.

**Please don't open a public issue for a vulnerability.** Use GitHub's private vulnerability reporting
(Security → Report a vulnerability) on this repository instead. Include what you found, how to reproduce it,
and what an attacker could do with it. You'll get a reply as soon as possible; this is a personal project, so
please allow a few days.

In scope: anything that could expose email content, tokens or another user's data; bypass the privacy filter,
the tester allow list or sign-in; or make the gateway act for the wrong user. Prompt-injection examples that make
the filter share something it should withhold or remove are in scope too.

Out of scope: the third-party services the gateway relies on (Google, AWS, WorkOS, Anthropic, OpenAI). Report those
to them directly.

Please don't test against accounts or inboxes that aren't yours.
