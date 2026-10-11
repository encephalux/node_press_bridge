# Webhooks WordPress

press_bridge n'interroge pas WordPress de lui-même : c'est WordPress qui doit prévenir l'application à chaque création, modification ou suppression de contenu.

## Routes

Les chemins sont libres ; l'exemple du [README](../README.md#démarrage-rapide) utilise :

| Méthode | Route | Chaîne |
|---|---|---|
| `POST` | `/press_bridge/add` | `middleware.add` → `controller.add` |
| `POST` | `/press_bridge/update` | `middleware.update` → `controller.update` |
| `POST` | `/press_bridge/remove` | `middleware.remove` → `controller.remove` |

Le corps est en JSON (`Content-Type: application/json`). La réponse est toujours `200` avec un corps vide, que la requête soit acceptée ou non.

## Corps des requêtes

### `add` et `update`

```json
{
  "id": 57,
  "post_type": "post",
  "slug": "premier-article",
  "title": "Premier article",
  "excerpt": "Résumé…",
  "date": "2026-10-05T08:30:00",
  "author": "admin",
  "thumbnail": "https://blog.example.com/wp-content/uploads/img.jpg",
  "status": "published"
}
```

- `excerpt` est requis sauf pour `post_type: "page"`.
- `slug`, `thumbnail` et `excerpt` peuvent valoir `""`, mais doivent être présents.
- `id` doit être un entier strictement positif (nombre ou chaîne) ; sinon la requête est ignorée.
- Seuls les contenus dont `status` vaut exactement `"published"` sont mis en cache, pages comme articles. WordPress utilise nativement `"publish"` : l'extension doit convertir la valeur (voir l'exemple ci-dessous).

### `remove`

```json
{ "id": 57, "post_type": "post" }
```

## Exemple côté WordPress

Extension minimale (à placer dans `wp-content/plugins/press-bridge-notify/press-bridge-notify.php`). Adaptez `PRESS_BRIDGE_URL`.

```php
<?php
/**
 * Plugin Name: press_bridge notify
 */

const PRESS_BRIDGE_URL = 'https://app.example.com/press_bridge';

function press_bridge_send($action, array $body) {
    wp_remote_post(PRESS_BRIDGE_URL . '/' . $action, [
        'headers'  => ['Content-Type' => 'application/json'],
        'body'     => wp_json_encode($body),
        'blocking' => false,
    ]);
}

function press_bridge_payload(WP_Post $post) {
    return [
        'id'        => $post->ID,
        'post_type' => $post->post_type,
        'slug'      => $post->post_name,
        'title'     => get_the_title($post),
        'excerpt'   => get_the_excerpt($post),
        'date'      => $post->post_date,
        'author'    => get_the_author_meta('display_name', $post->post_author),
        'thumbnail' => get_the_post_thumbnail_url($post, 'full') ?: '',
        'status'    => $post->post_status === 'publish' ? 'published' : $post->post_status,
    ];
}

add_action('wp_after_insert_post', function ($post_id, $post, $update) {
    if (wp_is_post_revision($post_id) || wp_is_post_autosave($post_id)) return;
    if (!in_array($post->post_type, ['page', 'post'], true)) return;
    press_bridge_send($update ? 'update' : 'add', press_bridge_payload($post));
}, 10, 3);

add_action('before_delete_post', function ($post_id, $post) {
    if (!in_array($post->post_type, ['page', 'post'], true)) return;
    press_bridge_send('remove', ['id' => $post_id, 'post_type' => $post->post_type]);
}, 10, 2);
```

Remarques :
- Un `update` reçu pour un contenu jamais enregistré est ignoré. Pour un site existant, envoyez un `add` pour chaque contenu lors de la mise en service.
- Le HTML est récupéré à `{target.url}/{slug}`. Les permaliens WordPress doivent donc correspondre à ce format (réglage « Titre de la publication »), y compris pour les articles.

## Sécurité

Les routes ne sont pas authentifiées par press_bridge. Protégez-les vous-même, par exemple avec un secret partagé vérifié dans un middleware placé avant `middleware.add` / `update` / `remove` :

```js
const check_secret = (req, res, next) =>
    req.get("X-Press-Bridge-Secret") === process.env.PRESS_BRIDGE_SECRET ? next() : res.sendStatus(401);

app.post("/press_bridge/add", check_secret, mw.add, ctrl.add);
```

Côté WordPress, ajoutez l'en-tête correspondant dans `press_bridge_send`.
