function getRndInteger(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

let hiddenPhotosIds = [];
for (i = 12; i < 55; i++) {
    hiddenPhotosIds.push(i);
}

setInterval(() => {
    let displayedPhotos = Array.from(
        document.getElementsByClassName("fade-in")
    );
    let displayedIds = displayedPhotos.map((item, i) => {
        return parseInt(item.id);
    });
    let randomIndex = getRndInteger(0, 11);
    const removePhoto = displayedPhotos[randomIndex];
    removePhoto.classList.remove("fade-in");
    removePhoto.classList.add("fade-out");
    setTimeout(() => {
        newRandomIndex = getRndInteger(0, 41);
        newPhoto = document.createElement("img");
        newPhoto.id = hiddenPhotosIds[newRandomIndex];
        newPhoto.setAttribute(
            "src",
            `../images/gallery/${hiddenPhotosIds[newRandomIndex]}.webp`
        );
        newPhoto.classList.add("fade-in");
        hiddenPhotosIds.splice(newRandomIndex, 1);
        hiddenPhotosIds.push(displayedIds[randomIndex]);
        const list = document.getElementById("photo-container");
        removePhoto.insertAdjacentElement("afterend", newPhoto);
        removePhoto.remove();
    }, 1000);
}, 3000);

setInterval(() => {
    let displayedPhotos = Array.from(
        document.getElementsByClassName("fade-in")
    );
    let displayedIds = displayedPhotos.map((item, i) => {
        return parseInt(item.id);
    });
    let randomIndex = getRndInteger(0, 10);
    const removePhoto = displayedPhotos[randomIndex];
    removePhoto.classList.remove("fade-in");
    removePhoto.classList.add("fade-out");
    setTimeout(() => {
        newRandomIndex = getRndInteger(0, 41);
        newPhoto = document.createElement("img");
        newPhoto.id = hiddenPhotosIds[newRandomIndex];
        newPhoto.setAttribute(
            "src",
            `../images/gallery/${hiddenPhotosIds[newRandomIndex]}.webp`
        );
        newPhoto.classList.add("fade-in");
        hiddenPhotosIds.splice(newRandomIndex, 1);
        hiddenPhotosIds.push(displayedIds[randomIndex]);
        const list = document.getElementById("photo-container");
        removePhoto.insertAdjacentElement("afterend", newPhoto);
        removePhoto.remove();
    }, 1000);
}, 3000);
