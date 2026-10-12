# Référence de l'API

```js
const {Bridge, middleware, controllers, env, utils} = require("node_press_bridge");
```

## `env`

Objet de configuration partagé par tous les modules.

| Clé | Type | Défaut | Description |
|---|---|---|---|
| `DIR` | `string` | `${process.cwd()}/press_bridge` | Répertoire de travail (registre et cache). |

`DIR` est lu au moment où un `Bridge` est construit : modifiez-le **avant** `new Bridge(...)`, et ne le changez plus ensuite. Le répertoire est créé par `init()` s'il n'existe pas.

## `Bridge`

### `new Bridge({target, options})`

| Paramètre | Type | Description |
|---|---|---|
| `target.url` | `string` | URL publique du site WordPress, sans `/` final. Le HTML d'un contenu est récupéré à `${target.url}/${slug}`. |
| `options.post_types` | `string[]` | Types de contenu acceptés. Défaut : `["page", "post"]`. |
| `options.types_to_buffer` | `string[]` | Types gardés en mémoire en plus du disque. Défaut : `["page"]`. Doit être un sous-ensemble de `post_types`. |

### Propriétés

| Propriété | Description |
|---|---|
| `options` | Options fusionnées avec les valeurs par défaut. |
| `target` | Objet `target` passé au constructeur. |
| `cache_dir` | `${env.DIR}/contents`. |
| `metadata` | Registre (`{[post_type]: {[id]: entrée}}`), voir [architecture.md](architecture.md#metadatajson). |
| `metadata_file` | Instance de `MetadataFile`. |
| `data` | Contenus en mémoire : `{[post_type]: {[id]: string \| null}}`, voir [architecture.md](architecture.md#mémoire). |
| `initialized` | `true` entre la fin de `init()` et `destroy()`. |
| `pending` | `Set` des promesses d'écriture en cours. |
| `destroying` | Promesse de la destruction en cours, ou `null`. |

### `async init()`

Crée `env.DIR` si besoin, charge le registre, crée les répertoires de cache et charge en mémoire les contenus publiés des types de `types_to_buffer`. Un fichier HTML manquant est journalisé sans bloquer. En cas d'échec, `metadata.json` est refermé et l'erreur est propagée.

### `async destroy()`

Attend la fin des opérations d'écriture en cours (`register`, `update`, `remove`, `update_cache`), puis sauvegarde le registre, ferme `metadata.json` et vide la mémoire.

- Pendant l'attente, toute nouvelle opération d'écriture est rejetée avec `DESTROYING`. Les lectures restent possibles.
- Une fois la destruction terminée, les méthodes lèvent `NOT_INITIALIZED` jusqu'au prochain `init()`.
- Un appel pendant une destruction en cours attend la fin de celle-ci. Sans effet si le bridge n'est pas initialisé.
- `metadata.json` est toujours fermé, même si la sauvegarde finale échoue ; la promesse est alors rejetée avec l'erreur de sauvegarde.

```js
process.on("SIGTERM", async () => {
    server.close();
    await bridge.destroy();
    process.exit(0);
});
```

### `async register(post)`

Ajoute un contenu au registre. S'il est au statut `"published"`, télécharge son HTML et le met en mémoire si son type figure dans `types_to_buffer`. Un échec du téléchargement est journalisé mais ne fait pas échouer l'appel.

| Champ | Requis | Description |
|---|---|---|
| `post_type` | oui | Doit figurer dans `options.post_types`. |
| `id` | oui | Identifiant WordPress. |
| `slug` | oui | Peut être `""`. |
| `title`, `date`, `author`, `status` | oui | Seul `status: "published"` déclenche la mise en cache. |
| `thumbnail` | oui | URL de l'image à la une, ou `""`. |
| `excerpt` | pour `post` | Conservé uniquement pour le type `post`. |

Erreurs : `NOT_INITIALIZED`, `UNSUPPORTED_POST_TYPE`, `ALREADY_REGISTERED_POST`, `DESTROYING`.

### `async update(post)`

Mêmes champs que `register`. Seuls les champs fournis remplacent les valeurs existantes (`slug`, `title`, `status` et `excerpt` acceptent `""` ; `date`, `author` et `thumbnail` sont ignorés s'ils sont vides). Si le contenu est publié après la mise à jour, son HTML est retéléchargé et remis en mémoire avant la résolution de la promesse. Retourne sans erreur si le contenu n'est pas enregistré.

Erreurs : `NOT_INITIALIZED`, `UNSUPPORTED_POST_TYPE`, `DESTROYING`.

### `async remove({post_type, id})`

Retire le contenu de la mémoire et du registre, puis supprime son fichier HTML. Fonctionne aussi pour un contenu non publié. Retourne sans erreur si le contenu n'est pas enregistré.

Erreurs : `NOT_INITIALIZED`, `UNSUPPORTED_POST_TYPE`, `DESTROYING`.

### `async get_by_id(post_type, id)` → `Promise<entrée & {content: string}>`

Retourne les métadonnées et le HTML d'un contenu publié. `id` peut être un nombre ou une chaîne.

```js
const page = await bridge.get_by_id("page", 42);
// {uuid, slug, title, date, author, thumbnail, status, content: "<html>…"}
```

Pour un type de `types_to_buffer`, le contenu est lu en mémoire ; s'il y manque, le fichier est relu et remis en mémoire.

Erreurs : `NOT_INITIALIZED`, `UNSUPPORTED_POST_TYPE`, `POST_NOT_FOUND`, `UNPUBLISHED_POST`, `CACHED_READ_ERROR`.

### `async get_by_slug(post_type, slug)` → `Promise<entrée & {content: string}>`

Comme `get_by_id`, mais recherche parmi les contenus **publiés** de ce slug. Un slug qui n'existe qu'en brouillon est traité comme introuvable, ce qui évite de révéler l'existence d'un brouillon.

Erreurs : `NOT_INITIALIZED`, `UNSUPPORTED_POST_TYPE`, `POST_NOT_FOUND`, `CACHED_READ_ERROR`.

### `async update_cache()`

Retélécharge un par un tous les contenus publiés et remet en mémoire ceux des types de `types_to_buffer`. Un échec est journalisé et n'interrompt pas la boucle.

Erreurs : `NOT_INITIALIZED`, `DESTROYING`.

### Méthodes utilitaires

| Méthode | Description |
|---|---|
| `get_post_type_dir(post_type)` | Répertoire du cache d'un type. |
| `get_post_file_path(post_type, post)` | Chemin du fichier HTML d'une entrée du registre. |

Les méthodes préfixées par `_` (`_download`, `_buffer`, `_get`) sont internes : elles ne vérifient ni l'initialisation ni le type, et ne sont pas suivies par `destroy()`.

## `middleware(bridge)`

Fabrique des middlewares Express qui valident `req.body` et copient les champs utiles dans `req.data_waggon`.

```js
const mw = middleware(bridge); // {add, update, remove}
```

| Middleware | Validation |
|---|---|
| `add`, `update` | `id` entier strictement positif, nombre ou chaîne en écriture décimale sans zéro initial ni espace (`42` ou `"42"`), transmis sous forme de chaîne ; `post_type` accepté par le bridge ; `title`, `date`, `author`, `status` non vides ; `slug` et `thumbnail` présents (`""` accepté) ; `excerpt` présent sauf pour `page`. |
| `remove` | `id` et `post_type` non vides. |

Si la validation échoue, la requête est terminée par `res.end()` (statut `200`, corps vide) et la chaîne s'arrête.

Prérequis : `req.body` doit être parsé (`express.json()` ou équivalent). `req.data_waggon` est créé s'il n'existe pas ; s'il existe déjà, les champs y sont ajoutés.

## `controllers(bridge)`

Fabrique les contrôleurs `{add, update, remove}`. Chacun répond immédiatement par `res.end()`, puis appelle respectivement `bridge.register`, `bridge.update` ou `bridge.remove` avec `req.data_waggon`. Les erreurs sont ignorées.

## `MetadataFile`

Utilisé par le `Bridge` ; rarement manipulé directement.

| Méthode | Description |
|---|---|
| `async load()` | Ferme le fichier déjà ouvert, crée `env.DIR`, ouvre (ou crée) `metadata.json` et le parse. Referme le fichier si le JSON est invalide. |
| `async save()` | Ajoute une sauvegarde à la file d'attente. Rejette avec `METADATA_CLOSED` si le fichier n'est pas ouvert. |
| `async close()` | Attend les sauvegardes en cours puis ferme le fichier. Sans effet s'il est déjà fermé. |

## `utils`

| Fonction | Description |
|---|---|
| `log(data)` | Écrit `data` sur la sortie standard. Utilisé pour tous les messages du module. |

## Codes d'erreur

| Code | Cause |
|---|---|
| `NOT_INITIALIZED` | Méthode appelée avant la fin de `init()` ou après `destroy()`. |
| `UNSUPPORTED_POST_TYPE` | Type absent de `options.post_types`. |
| `ALREADY_REGISTERED_POST` | `register` sur un `id` déjà présent. |
| `POST_NOT_FOUND` | Aucun contenu avec cet `id`, ou aucun contenu publié avec ce slug. |
| `UNPUBLISHED_POST` | `get_by_id` sur un contenu dont le statut n'est pas `"published"`. |
| `CACHED_READ_ERROR` | Le fichier HTML d'un contenu publié est illisible ou absent (téléchargement échoué, par exemple). |
| `DESTROYING` | Opération d'écriture lancée pendant `destroy()`. |
| `METADATA_CLOSED` | `MetadataFile.save()` appelé alors que `metadata.json` n'est pas ouvert. |

## Messages de log

| Message | Contexte |
|---|---|
| `REGISTERING UNSUPPORTED POST TYPE` / `REGISTERING REGISTERED POST` | `register` refusé. |
| `UPDATING UNSUPPORTED POST TYPE` / `UNREGISTERED POST UPDATING` | `update` refusé ou ignoré. |
| `REMOVING UNSUPPORTED POST TYPE` / `UNREGISTERED POST REMOVING` | `remove` refusé ou ignoré. |
| `FAILED TO REMOVE POST HTML FILE` | Suppression du fichier HTML impossible (hors fichier absent). |
| `REQUESTING UNSUPPORTED POST TYPE CACHED FILE` | `get_by_id` / `get_by_slug` sur un type non géré. |
| `CAN'T READ PUBLISHED POST FILE` | Lecture du fichier HTML d'un contenu publié en échec. |
| `FAILED TO GET POST CONTENT` | Téléchargement depuis WordPress en échec. |
| `ERROR ON POST FILE WRITING` | Écriture du fichier HTML en échec. |
| `BUFFERING FAILED ON INIT` | Mise en mémoire d'un contenu publié impossible au démarrage. |
| `DOWNLOAD FAILED ON CACHE UPDATING` / `BUFFERING FAILED ON CACHE UPDATING` | Échec pendant `update_cache()`. |
| `ERROR ON METADATA PARSING` | `metadata.json` illisible (JSON invalide). |
| `METADATA FILE WRITING FAILED` | Sauvegarde de `metadata.json` en échec. |
