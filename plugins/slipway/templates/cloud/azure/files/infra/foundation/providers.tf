# subscription_id comes from ARM_SUBSCRIPTION_ID (required by azurerm >= 4.0; kept out of the repository).
provider "azurerm" {
  # providers are registered once per subscription by an owner; the CI/CD principal must not need that right
  resource_provider_registrations = "none"

  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
  }
}

# Used only to look up the CI/CD service principal by display name (read access to Entra ID).
provider "azuread" {}
