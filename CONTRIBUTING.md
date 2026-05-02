# How to Contribute

We would love to accept your patches and contributions to this project.

## Before you begin

### Sign our Contributor License Agreement

Contributions to this project must be accompanied by a
[Contributor License Agreement](https://cla.developers.google.com/about) (CLA).
You (or your employer) retain the copyright to your contribution; this simply
gives us permission to use and redistribute your contributions as part of the
project.

If you or your current employer have already signed the Google CLA (even if it
was for a different project), you probably don't need to do it again.

Visit <https://cla.developers.google.com/> to see your current agreements or to
sign a new one.

### Review our Community Guidelines

This project follows [Google's Open Source Community
Guidelines](https://opensource.google/conduct/).

## Contribution process

### Development Setup

1.  **Clone the repository**:
    ```bash
    jj git clone git@github.com:brychanrobot/jj-view.git
    cd jj-view
    ```
2.  **Install dependencies**:
    ```bash
    pnpm install
    ```
    *Note: The `prepare` script will automatically generate necessary assets (themes and icons) after installation.*
3.  **Configure Jujutsu**:
    Run the setup script to link the repository-specific `jj` configuration:
    ```bash
    pnpm setup-jj
    ```
4.  **Build the project**:
    If you need to manually regenerate assets or perform a full build:
    ```bash
    pnpm build
    ```
5.  **Run the extension**:
    Open the project in VS Code and press `F5` to start the extension in a new Extension Development Host window.

### Code Reviews

All submissions, including submissions by project members, require review. We
use [GitHub pull requests](https://docs.github.com/articles/about-pull-requests)
for this purpose.
