# Pull requests from forks

GitHub gives a `pull_request` run from a fork **no secrets and a read-only token**. That is a protection, not a bug: the workflow runs the fork's code, and anyone can open a pull request from a fork. The Action handles both:

- tests that need a secret are **blocked (missing secret)**, not failed, and the comment says why. The check is neutral;
- the comment and check can't be posted with a read-only token: the Action warns, and the results are in the job summary.

In the default `replay-only` mode, a fork's run needs no AI key and behaves exactly like a branch's, apart from the secrets.

To test a fork's change with secrets, a maintainer pushes it to a branch in the repository.

## Never `pull_request_target` for running tests

`pull_request_target` runs in the context of your repository: **with your secrets and a write token**. A workflow that checks out and runs the pull request's code there hands both to anyone who opens a pull request from a fork. Their code can read every secret the job has (your test passwords, your AI key) and use the token to push to your repository.

Don't work around the missing secrets with it. The same applies in other CI systems: never expose secrets to jobs for merge requests from forks (Bitbucket, for example, doesn't pass secured variables to them, so those tests are blocked).

## Why blocked, not failed

A test that couldn't run says nothing about your code. Showing it as failed would make every fork PR red; showing it as passed would hide that nothing was checked. **Blocked is neutral**: branch protection lets it through, and the comment says exactly what couldn't run.
