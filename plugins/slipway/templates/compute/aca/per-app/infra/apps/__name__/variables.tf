variable "image_tag" {
  type        = string
  description = "Immutable image tag produced by CI (semver). Deployed for this app only."

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+", var.image_tag)) && !contains(["latest", "main", "dev"], var.image_tag)
    error_message = "image_tag must be an immutable semver tag from CI (for example 0.1.13), never latest or a branch name."
  }
}
