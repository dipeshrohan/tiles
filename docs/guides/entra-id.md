# Sign-in with Microsoft Entra ID, and SCIM provisioning (T5.05)

This guide is for an organisation admin connecting their organisation's Microsoft Entra ID tenant to Tiles. Their people then sign in with their work accounts, and Entra ID creates, updates and removes their Tiles accounts. Any other OpenID Connect provider works the same way for sign-in; SCIM needs a provider with a SCIM 2.0 client (Okta, OneLogin, JumpCloud and others have one).

How it works:

- **Sign-in.** The organisation gets **its own identity provider**. Tokens from its issuer sign in to that organisation only, whatever they claim, so a customer's tenant can never reach another organisation. Its groups or app roles map to Tiles roles.
- **Enforced sign-in.** Once sign-in through it works, an admin can **enforce** it: no other sign-in reaches the organisation then, including the deployment's own provider.
- **Provisioning (SCIM 2.0).** Entra ID creates people's accounts before their first sign-in, updates their names and emails, and deactivates or deletes them when they leave. A deactivated person can't sign in, even with a token they already hold.

Everything here is on the **Settings** page under *Organisation sign-in*, shown to organisation admins, or through the API (`/org/identity-provider`, `/org/scim-tokens`; [API reference](api.md)).

## 1. Register Tiles in Entra ID

In the [Entra admin center](https://entra.microsoft.com), under *Identity → Applications → App registrations*, make two registrations: one for the API, one for the browser.

**The API: `Tiles API`.**

1. *New registration*, single tenant, no redirect URI. Note its **Application (client) ID**: it is the tokens' audience.
2. *Expose an API*:
   - set the Application ID URI (`api://<API app ID>`);
   - add a scope named `access`, which admins and users can consent to.
3. *Manifest*: set `"requestedAccessTokenVersion": 2`. Tiles accepts v2 tokens only, whose issuer is `https://login.microsoftonline.com/<tenant ID>/v2.0`.
4. *App roles* (optional): add `tiles-engineer` and `tiles-admin` (value exactly so, for *Users/Groups*), then assign them to people or groups under *Enterprise applications → Tiles API → Users and groups*. Without a role, people are viewers.
5. *Token configuration* (optional): add the `groups` claim (*Security groups*, as group IDs) if you prefer to map groups to roles in Tiles instead of using app roles.

**The browser: `Tiles`.**

1. *New registration*, single tenant, with a **Single-page application** redirect URI: the address people open Tiles at, for example `https://tiles.example.com/`. Note its Application (client) ID.
2. *API permissions*: add *My APIs → Tiles API → access*, and grant admin consent.

No client secret is needed: the browser is a public client and uses PKCE.

## 2. Connect the tenant to Tiles

In Tiles, under **Settings → Organisation sign-in**, as an organisation admin, enter:

| Field | Value |
|---|---|
| Issuer | `https://login.microsoftonline.com/<tenant ID>/v2.0` |
| Browser client ID | the `Tiles` registration's Application ID |
| Audience | the `Tiles API` registration's Application ID |
| Scope | `openid profile email offline_access api://<API app ID>/access` |
| Signing keys | empty: found from the issuer |
| Groups | optional: one `<group object ID> = engineer` (or `admin`, `viewer`) per line |

Save it. People sign in on the Settings page under *Or with your organisation's own sign-in*, giving the organisation's short name (its slug). The browser remembers it for next time.

**Confirm it first.** A provider you save starts *not confirmed*, and takes no one but you. Sign in through it yourself, as above, with the same email you use in Tiles. That confirms your organisation controls the tenant, and from then on its people can sign in.

This is what stops one organisation from claiming another's tenant. Once an organisation has confirmed an issuer, no other organisation can save it.

**Roles.** A person gets the highest role among:

- their app roles (`tiles-admin`, `tiles-engineer`);
- the roles their groups map to;
- otherwise, viewer.

As with every sign-in, this sets their role on a site they open for the first time. After that, site admins change it on the site. **Organisation admin** is a Tiles setting, not a role in the token, though `tiles-admin` also lets someone create sites and manage the organisation's sign-in.

**People who signed in before.** If your organisation used the deployment's own provider before, its people keep their accounts. The first time they sign in through Entra ID, their account moves to it, matched by email. It moves back the same way if they sign in through the deployment's provider again, unless the provider is enforced. An account never moves to another identity of the same provider.

**Enforcing it.** When the provider is confirmed, sign in through it, then tick *Refuse every other sign-in* and save. Tiles only lets you turn this on for a confirmed provider while you are signed in through it, so a provider that doesn't work can't lock everyone out. If it breaks later (a tenant moved, say), the deployment's operators turn enforcement off in the database: `UPDATE org_identity_providers SET enforced = false WHERE issuer = '<issuer>'`. An organisation admin can then sign in through the deployment's provider and fix or remove it.

**Removing it** stops its tokens at once: every request checks the organisation's provider. People sign in through the deployment's provider again.

**Checked at sign-in:**

- each token's signature, issuer, audience and expiry;
- the person's email, from `email`, or else `preferred_username` or `upn`, which are email addresses in Entra ID.

A token from an issuer no organisation has registered gets 401. A deactivated or deleted person gets 403.

Tiles fetches a provider's discovery document and signing keys only from public https addresses, never from addresses inside your network or the cluster.

## 3. Provision people with SCIM

1. In Tiles, under **Settings → Organisation sign-in → User provisioning**, make a token, for example "Entra ID provisioning". **Copy it now:** Tiles keeps only its hash.
2. In Entra ID, under *Enterprise applications → New application → Create your own application*, choose *Integrate any other application you don't find in the gallery*. Then open *Provisioning*:
   - **Provisioning mode:** Automatic.
   - **Tenant URL:** the address on the Settings page, `https://<API address>/scim/v2`.
   - **Secret token:** the token from step 1.
   - *Test connection*, then save.
3. **Mappings:** keep *Provision Microsoft Entra ID Users*, and turn off *Groups*: Tiles provisions users only. The default user mapping works:
   - `userPrincipalName` → `userName`, which must be the person's email address;
   - `objectId` → `externalId`;
   - `displayName`, `givenName`, `surname`, `mail`, and `Switch([IsSoftDeleted]…)` → `active`.

   Tiles keeps the email, name, external ID and active state; it accepts other attributes (title, department, phone numbers…) and ignores them.
4. **Scope:** under *Users and groups*, assign the people or groups to provision. Then start provisioning.

What happens to people:

| In Entra ID | In Tiles |
|---|---|
| Assigned | An account is made (or one deleted before comes back, with its history). When the person signs in, the account is theirs, matched by email |
| Name or email changed | Updated |
| Disabled, or unassigned (soft delete) | Deactivated: they can't sign in, and their site memberships are kept for when they come back |
| Deleted | Deleted: they can't sign in, and their site memberships end. What they did stays in the history under their name |

Every change is recorded in the audit log, as `SCIM: <token name>`. Revoking the token stops provisioning at once. Tokens show when they were last used.

Tiles' SCIM service:

- **Users:** `GET`, `POST`, `PUT`, `PATCH` and `DELETE` on `/scim/v2/Users`.
- **Filters:** `userName`, `externalId` or `emails.value` `eq "…"`.
- **Paging:** `startIndex` and `count`, up to 200.
- **Discovery:** `/ServiceProviderConfig` and `/ResourceTypes`.
- **Not supported:** groups, bulk operations, sorting and ETags.
