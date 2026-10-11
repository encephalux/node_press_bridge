# Architecture

## Modules

| Fichier | Rôle |
|---|---|
| `src/index.js` | Point d'entrée. Fixe `env.DIR` par défaut et exporte les autres modules. |
| `src/env.js` | Configuration partagée (objet mutable). |
| `src/Bridge.js` | Cœur du module : registre, cache disque, mémoire. |
| `src/MetadataFile.js` | Lecture et écriture de `metadata.json`. |
| `src/middleware.js` | Validation des requêtes webhook et construction de `req.data_waggon`. |
| `src/controller.js` | Répond immédiatement à WordPress puis délègue au `Bridge`. |
| `src/utils.js` | Journalisation (`console.log`). |

## Stockage

Tout est rangé sous `env.DIR` (par défaut `${process.cwd()}/press_bridge`), qui ne doit pas changer pendant l'exécution :

```
{env.DIR}/
├── metadata.json
└── contents/
    ├── page/
    │   └── 3f2c…-uuid.html
    └── post/
        └── 9a1b…-uuid.html
```

### `metadata.json`

Registre de tous les contenus reçus, publiés ou non, indexé par type puis par identifiant WordPress :

```json
{
  "page": {
    "42": {
      "uuid": "3f2c8e0a-…",
      "slug": "a-propos",
      "title": "À propos",
      "date": "2026-10-01T10:00:00",
      "author": "admin",
      "thumbnail": "",
      "status": "published"
    }
  },
  "post": {
    "57": {
      "uuid": "9a1b…",
      "slug": "premier-article",
      "title": "Premier article",
      "excerpt": "Résumé…",
      "date": "2026-10-05T08:30:00",
      "author": "admin",
      "thumbnail": "https://blog.example.com/wp-content/uploads/img.jpg",
      "status": "draft"
    }
  }
}
```

- `uuid` est généré à l'enregistrement (`crypto.randomUUID()`) et donne le nom du fichier HTML. Il ne change pas quand le slug change.
- `excerpt` n'existe que pour le type `post`.
- Le fichier reste ouvert entre `init()` et `destroy()`. Les sauvegardes passent par une file d'attente : elles s'exécutent une par une, et `close()` attend la dernière avant de fermer le fichier.

### Fichiers HTML

`contents/<post_type>/<uuid>.html` contient la réponse brute de `GET {target.url}/{slug}`, c'est-à-dire la page telle que WordPress la rend publiquement. Seuls les contenus au statut `"published"` sont téléchargés.

L'écriture passe par un fichier temporaire `<uuid>.html.<uuid aléatoire>.tmp` renommé ensuite : un lecteur ne voit jamais un fichier à moitié écrit, et deux téléchargements simultanés du même contenu n'écrivent pas dans le même fichier temporaire.

### Mémoire

`bridge.data[post_type][id]` contient le HTML (chaîne UTF-8) des contenus publiés dont le type figure dans `options.types_to_buffer`.

| Valeur | Signification |
|---|---|
| chaîne | Contenu en mémoire. |
| `null` | La dernière lecture du fichier a échoué. |
| absente | Pas encore chargé (téléchargement échoué, brouillon…). |

Pour `null` ou une valeur absente, `get_by_id`/`get_by_slug` relisent le disque et remettent le contenu en mémoire ; si le fichier manque, ils lèvent `CACHED_READ_ERROR`.

## Cycle de vie d'un contenu

### Initialisation (`bridge.init()`)

1. Création de `env.DIR` si besoin, puis ouverture de `metadata.json` (créé avec `{}` s'il est absent).
2. Création de `contents/` puis d'un sous-répertoire par type de `post_types`.
3. Ajout d'une entrée vide dans `metadata` pour chaque type absent.
4. Chargement en mémoire des contenus publiés des types de `types_to_buffer`. Un fichier manquant est journalisé (`BUFFERING FAILED ON INIT`) sans bloquer le démarrage.
5. Sauvegarde du registre. En cas d'échec à l'une de ces étapes, `metadata.json` est refermé et l'erreur est propagée.
6. `bridge.initialized` passe à `true`. Les autres méthodes lèvent `NOT_INITIALIZED` avant cette étape.

### Création (webhook `add` → `register`)

1. Le middleware valide le corps et remplit `req.data_waggon`.
2. Le contrôleur répond tout de suite (`res.end()`), puis appelle `bridge.register()`.
3. Le contenu est ajouté au registre et le registre est sauvegardé.
4. Si `status === "published"`, le HTML est téléchargé et écrit sur disque, puis chargé en mémoire si le type figure dans `types_to_buffer`.

### Modification (webhook `update` → `update`)

Seuls les champs fournis sont remplacés, puis le registre est sauvegardé. Si le contenu est (ou devient) publié, son HTML est retéléchargé et remis en mémoire ; la promesse se résout après cette étape. Un contenu inconnu du registre est ignoré (avec un message dans les logs).

Quand un contenu est dépublié, il reste au registre et n'est plus servi (`UNPUBLISHED_POST`), mais son fichier HTML et son entrée en mémoire ne sont pas supprimés.

### Suppression (webhook `remove` → `remove`)

L'entrée est retirée de la mémoire et du registre, le registre est sauvegardé, puis le fichier HTML est supprimé (un fichier absent est ignoré).

### Lecture (`get_by_id`, `get_by_slug`)

1. Le contenu est cherché dans le registre (`POST_NOT_FOUND` s'il n'existe pas). `get_by_slug` ne considère que les contenus publiés.
2. Un contenu non publié lève `UNPUBLISHED_POST`.
3. Le contenu est lu en mémoire ou sur le disque selon `types_to_buffer`.

### Rafraîchissement (`bridge.update_cache()`)

Retélécharge un par un tous les contenus publiés et remet en mémoire ceux des types de `types_to_buffer`. Un échec est journalisé et n'interrompt pas la boucle.

### Libération (`bridge.destroy()`)

1. Les nouvelles opérations d'écriture sont refusées (`DESTROYING`).
2. Le bridge attend la fin des opérations d'écriture en cours, suivies dans `bridge.pending`.
3. Le registre est sauvegardé, `metadata.json` est fermé (même si la sauvegarde échoue) et la mémoire est vidée.
4. `bridge.initialized` repasse à `false` ; un nouvel appel à `init()` recharge le bridge.

## Gestion des erreurs

- Les erreurs sont levées sous forme `new Error(CODE)` ; voir la liste dans [api.md](api.md#codes-derreur).
- Les contrôleurs répondent à WordPress avant le traitement et ignorent les erreurs : WordPress reçoit toujours une réponse `200` vide, y compris en cas d'échec. Les échecs ne sont visibles que dans les logs.
- Les erreurs de téléchargement ou de mise en mémoire lors de `register`/`update` ne font pas échouer l'appel ; le contenu reste au registre.
